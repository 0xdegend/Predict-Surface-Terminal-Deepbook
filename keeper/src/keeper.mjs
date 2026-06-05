/**
 * keeper/src/keeper.mjs — the orchestration loop.
 *
 * discover (settled oracles → active managers → scan positions) → for each
 * unclaimed in-the-money position, submit redeem_permissionless. Honours a
 * per-candidate cooldown so we don't resubmit while the indexer catches up,
 * caps work per tick, and supports a dry-run mode (no signing).
 */
import { mapPool } from './server.mjs';
import {
  settledOracleMap,
  redeemCandidatesForManager,
  candidateKey,
} from './scan.mjs';
import { buildRedeemPermissionlessTx } from './redeem.mjs';
import { fromQuote } from './config.mjs';

/** Find every unclaimed in-the-money position across managers active on settled oracles. */
export async function discoverCandidates(server, opts) {
  const oracles = await server.getOracles();
  const settledMap = settledOracleMap(oracles);

  const minted = await server.getPositionsMinted(opts.mintedLimit);
  const managers = [
    ...new Set(minted.filter((m) => settledMap.has(m.oracle_id)).map((m) => m.manager_id)),
  ].slice(0, opts.managerScanLimit);

  const lists = await mapPool(managers, opts.concurrency, (id) => server.getManagerPositions(id));

  const candidates = [];
  lists.forEach((positions, i) => {
    if (!positions) return;
    for (const c of redeemCandidatesForManager(positions, settledMap)) {
      candidates.push({ ...c, managerId: managers[i] });
    }
  });
  return { candidates, settledCount: settledMap.size, managerCount: managers.length };
}

/** One discover → redeem pass. Returns a summary; logs progress via `log`. */
export async function runOnce({ server, client, signer, cfg, opts, seen, log }) {
  const now = Date.now();
  const { candidates, settledCount, managerCount } = await discoverCandidates(server, opts);

  // Drop candidates we acted on recently (cooldown) to avoid duplicate submits.
  const fresh = candidates.filter((c) => {
    const last = seen.get(candidateKey(c));
    return last === undefined || now - last > opts.cooldownMs;
  });
  const batch = fresh.slice(0, opts.maxRedeemsPerTick);

  log(
    `scan: ${settledCount} settled oracles · ${managerCount} managers · ` +
      `${candidates.length} claimable · ${fresh.length} fresh · acting on ${batch.length}` +
      (opts.dryRun ? ' (dry-run)' : ''),
  );

  let succeeded = 0;
  for (const c of batch) {
    seen.set(candidateKey(c), now);
    const label =
      `${c.managerId.slice(0, 10)}… ${c.isUp ? 'UP' : 'DN'} ` +
      `K=${(Number(c.strike) / 1e9).toFixed(0)} payout≈${fromQuote(c.payout, cfg).toFixed(4)}`;
    const tx = buildRedeemPermissionlessTx(cfg, c);

    if (opts.dryRun) {
      if (!signer) {
        log(`  would redeem ${label}`);
        continue;
      }
      try {
        tx.setSender(signer.toSuiAddress());
        const bytes = await tx.build({ client });
        const sim = await client.dryRunTransactionBlock({ transactionBlock: bytes });
        const ok = sim.effects?.status?.status === 'success';
        log(`  dry-run ${ok ? 'OK' : 'FAIL'} ${label}${ok ? '' : ' · ' + sim.effects?.status?.error}`);
      } catch (e) {
        log(`  dry-run ERROR ${label} · ${e instanceof Error ? e.message : e}`);
      }
      continue;
    }

    try {
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: { showEffects: true },
      });
      await client.waitForTransaction({ digest: res.digest });
      const ok = res.effects?.status?.status === 'success';
      if (ok) succeeded++;
      log(`  ${ok ? '✓ redeemed' : '✗ failed'} ${label} · ${cfg.explorer}/tx/${res.digest}`);
    } catch (e) {
      log(`  ✗ error ${label} · ${e instanceof Error ? e.message : e}`);
    }
  }

  return { found: candidates.length, fresh: fresh.length, attempted: batch.length, succeeded };
}

/** Poll forever. Resolves only if stopped (it never is) — Ctrl-C to exit. */
export async function runLoop(ctx) {
  const { opts, log } = ctx;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      await runOnce(ctx);
    } catch (e) {
      log(`tick error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
}
