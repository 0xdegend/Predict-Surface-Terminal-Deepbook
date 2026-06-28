/**
 * keeper/v2/keeper.mjs — orchestration for the v2 keeper.
 *
 * Two permissionless jobs per tick:
 *  1. SETTLED REDEEM  — for each settled market, claim every in-the-money open
 *     order (redeem_settled; payout goes to the owner's account, keeper pays gas).
 *  2. LIQUIDATION     — for each live market, dry-run liquidate_order on leveraged
 *     orders and submit the ones that would succeed (underwater).
 *
 * Both need per-market ORDER discovery, which the beta indexer doesn't expose yet
 * (see server.mjs). Until it does, the keeper reports settled markets and idles on
 * the redeem/liquidate steps — no crashes, ready to activate.
 */
import { mapPool } from './server.mjs';
import { settledMarketMap, redeemCandidates, liquidationCandidates, candidateKey } from './scan.mjs';
import { buildRedeemSettledTx, buildLiquidateOrderTx } from './tx.mjs';
import { fromQuote } from './config.mjs';

async function dryRunOk(client, tx, signer) {
  tx.setSender(signer.toSuiAddress());
  const bytes = await tx.build({ client });
  const sim = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  return { ok: sim.effects?.status?.status === 'success', err: sim.effects?.status?.error };
}

async function submit(client, tx, signer) {
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  await client.waitForTransaction({ digest: res.digest });
  return { ok: res.effects?.status?.status === 'success', digest: res.digest };
}

export async function runOnce({ server, client, signer, cfg, opts, seen, log }) {
  const now = Date.now();
  const markets = await server.getMarkets(opts.marketLimit);
  if (markets.__notFound || !Array.isArray(markets)) {
    log('markets endpoint unavailable — skipping tick');
    return;
  }
  const settledIds = markets.filter((m) => m.expiry <= now).map((m) => m.expiry_market_id);
  const liveMarkets = markets.filter((m) => m.expiry > now);

  // Settlement state for recently-expired markets.
  const states = (await mapPool(settledIds.slice(0, opts.stateScanLimit), opts.concurrency, (id) => server.getMarketState(id)))
    .filter((s) => s && !s.__notFound);
  const settled = settledMarketMap(states);

  // ---- discovery (guarded) ----
  let ordersAvailable = false;
  const redeemBatch = [];
  const liquidateBatch = [];

  for (const marketId of settled.keys()) {
    const { available, orders } = await server.getOrdersForMarket(marketId);
    ordersAvailable = ordersAvailable || available;
    if (available) redeemBatch.push(...redeemCandidates(marketId, orders, settled.get(marketId)));
  }
  for (const m of liveMarkets.slice(0, opts.liquidationMarketLimit)) {
    const { available, orders } = await server.getOrdersForMarket(m.expiry_market_id);
    ordersAvailable = ordersAvailable || available;
    if (available) liquidateBatch.push(...liquidationCandidates(m.expiry_market_id, orders));
  }

  log(
    `scan: ${markets.length} markets · ${settled.size} settled · ${liveMarkets.length} live · ` +
      (ordersAvailable
        ? `${redeemBatch.length} redeemable · ${liquidateBatch.length} leveraged to probe`
        : 'order discovery OFFLINE (indexer endpoints not live yet) — idle') +
      (opts.dryRun ? ' (dry-run)' : ''),
  );
  if (!ordersAvailable) return { settled: settled.size, redeemable: 0, liquidated: 0 };

  // ---- settled redeem ----
  let redeemed = 0;
  for (const c of dedupe(redeemBatch, seen, now, opts).slice(0, opts.maxPerTick)) {
    seen.set(candidateKey(c), now);
    const label = `redeem ${c.marketId.slice(0, 10)}… order ${c.orderId} q=${fromQuote(c.closeQuantity, cfg).toFixed(4)}`;
    const tx = buildRedeemSettledTx(cfg, c);
    if (opts.dryRun) {
      const { ok, err } = await dryRunOk(client, tx, signer);
      log(`  dry-run ${ok ? 'OK' : 'FAIL'} ${label}${ok ? '' : ' · ' + err}`);
      continue;
    }
    try {
      const { ok, digest } = await submit(client, tx, signer);
      if (ok) redeemed++;
      log(`  ${ok ? '✓' : '✗'} ${label} · ${cfg.explorer}/tx/${digest}`);
    } catch (e) {
      log(`  ✗ error ${label} · ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---- liquidation (dry-run gates submission so healthy orders cost no gas) ----
  let liquidated = 0;
  for (const c of liquidateBatch.slice(0, opts.maxPerTick)) {
    const label = `liquidate ${c.marketId.slice(0, 10)}… order ${c.orderId}`;
    const tx = buildLiquidateOrderTx(cfg, c);
    const { ok, err } = await dryRunOk(client, tx, signer);
    if (!ok) continue; // healthy order — skip silently
    if (opts.dryRun) {
      log(`  dry-run WOULD liquidate ${label}`);
      continue;
    }
    try {
      const r = await submit(client, buildLiquidateOrderTx(cfg, c), signer);
      if (r.ok) liquidated++;
      log(`  ${r.ok ? '✓' : '✗'} ${label} · ${cfg.explorer}/tx/${r.digest}`);
    } catch (e) {
      log(`  ✗ error ${label} · ${e instanceof Error ? e.message : e}`);
      if (err) log(`    (dry-run note: ${err})`);
    }
  }

  return { settled: settled.size, redeemable: redeemBatch.length, redeemed, liquidated };
}

function dedupe(batch, seen, now, opts) {
  return batch.filter((c) => {
    const last = seen.get(candidateKey(c));
    return last === undefined || now - last > opts.cooldownMs;
  });
}

export async function runLoop(ctx) {
  const { opts, log } = ctx;
  for (;;) {
    try {
      await runOnce(ctx);
    } catch (e) {
      log(`tick error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
}
