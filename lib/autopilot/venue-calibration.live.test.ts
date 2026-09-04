/**
 * venue-calibration.live.test.ts — is the venue pricing bets honestly, and are ours?
 *
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/autopilot/venue-calibration.live.test.ts
 *
 * Built 2026-09-04 to answer "why is Autopilot on a losing streak since 8-21". Three reads:
 *   A. what the chain's `entry_probability` means for a DOWN bet (it is the buyer's own
 *      win chance, equal to premium/quantity, not the UP probability of the strike), and
 *      the abort reason when a strike is outside the market's probability policy;
 *   B. across EVERY trader's recent mints on settled markets, realized win rate against
 *      priced win chance, by bucket, side, and time left at mint. On 8-21 that day: bets
 *      priced 70-80% won 84% (n=44), 80-90% won 83%, 90%+ won 90%; DOWN >=70% won 82%.
 *      A venue that is calibrated like this is not the cause of a losing streak;
 *   C. our own wallet's bets, one line each, with the settlement price beside the strike.
 * Reads only; prints a report. Set QUOTE_OWNER to quote from another funded wallet.
 */
import { describe, it } from 'vitest';
import { v2ReadClient } from '@/lib/sui/grpc-core';
import { readWrapper } from '@/lib/sui/v2/account';
import { binaryTicks } from '@/lib/sui/v2/ticks';
import { quoteBudgetMint } from '@/lib/sui/v2/quote-mint';
import { onchainAllOrders, onchainMarkets, onchainMarketState, onchainPythLatest } from '@/lib/api/v2/onchain';
import { fromFloat, toFloat } from '@/config/scale';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';

const RUN = process.env.RUN_LIVE === '1';
const OWNER = process.env.QUOTE_OWNER ?? '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';
const n = (v: unknown) => Number(v ?? 0);
const when = (ms: number) => new Date(ms).toISOString().slice(11, 19);

describe.skipIf(!RUN)('8-21 pricing sanity', () => {
  it('A: DOWN quote semantics', async () => {
    const client = v2ReadClient();
    const { wrapperId } = await readWrapper(client.core, OWNER);
    const obs = (await onchainPythLatest()) as unknown as Record<string, unknown>;
    const spot = Number(obs.price_magnitude) * 10 ** -Number(obs.exponent_magnitude);
    const now = Date.now();
    const m = (await onchainMarkets(60)).filter((x) => x.expiry > now + 180_000).sort((a, b) => a.expiry - b.expiry)[0];
    if (!m) {
      console.log('\n  A: no market with 3+ minutes left right now, nothing to quote');
      return;
    }
    console.log(`\n  spot ${spot.toFixed(2)}, market ${m.expiry_market_id.slice(0, 10)}… ${((m.expiry - now) / 60000).toFixed(1)} min left`);
    for (const [label, strike, isUp] of [['UP   below spot', spot * 0.998, true], ['UP   above spot', spot * 1.002, true], ['DOWN above spot', spot * 1.002, false], ['DOWN below spot', spot * 0.998, false]] as const) {
      const { lowerTick, higherTick } = binaryTicks(fromFloat(Math.round(strike)), isUp, m.tick_size);
      const q = await quoteBudgetMint(client.core, { owner: OWNER, wrapperId, marketId: m.expiry_market_id, lowerTick, higherTick, amount: 5_000_000n, leverage: 1_000_000_000n });
      const pq = q ? Number(q.premiumBase) / Number(q.quantityBase) : NaN;
      let why = '';
      if (!q) {
        const { buildMintBudgetTx } = await import('@/lib/sui/v2/predict-tx');
        const tx = buildMintBudgetTx({ marketId: m.expiry_market_id, wrapperId, lowerTick, higherTick, amount: 5_000_000n, minQuantity: 0n, leverage: 1_000_000_000n });
        tx.setSender(OWNER);
        const res = (await client.core.simulateTransaction({ transaction: tx, include: { events: true } as never, checksEnabled: false })) as Record<string, unknown>;
        why = ` kind=${String(res.$kind)} ${JSON.stringify((res as { FailedTransaction?: { status?: unknown } }).FailedTransaction?.status ?? '').slice(0, 300)}`;
      }
      console.log(`  ${label} @ ${Math.round(strike)}  entry_probability ${q?.entryProb.toFixed(3) ?? 'null'}  premium/quantity ${pq.toFixed(3)}${why}`);
    }
  }, 120_000);

  it('B + C: realized vs priced, every trader, and ours', async () => {
    const events = await onchainAllOrders(800);
    const mints = events.filter((e) => e.kind === 'order_minted');
    const markets = new Map<string, V2Market>();
    const settled = new Map<string, number>();
    const ids = [...new Set(mints.sort((a, b) => n(b.checkpoint_timestamp_ms) - n(a.checkpoint_timestamp_ms)).map((e) => String(e.expiry_market_id)))].slice(0, 150);
    for (const id of ids) {
      try {
        const st = await onchainMarketState(id);
        markets.set(id, st.market);
        const raw = st.settlement?.settlement_price;
        if (raw != null) settled.set(id, toFloat(BigInt(raw)));
      } catch { /* skip */ }
    }
    type Shape = 'up' | 'down' | 'range';
    type Row = { owner: string; at: number; id: string; shape: Shape; isUp: boolean; strike: number; lower: number; higher: number; prob: number; pq: number; left: number; px: number; won: boolean; stake: number };
    const rows: Row[] = [];
    for (const e of mints) {
      const id = String(e.expiry_market_id);
      const mk = markets.get(id);
      const px = settled.get(id);
      if (!mk || px == null) continue;
      const tick = toFloat(BigInt(mk.tick_size));
      const isUp = BigInt(e.higher_tick ?? 0) === POS_INF_TICK;
      const lower = n(e.lower_tick) * tick;
      const higher = n(e.higher_tick) * tick;
      // A range is a band with neither sentinel: lower_tick 0 is minus infinity (DOWN),
      // higher_tick POS_INF is plus infinity (UP).
      const shape: Shape = isUp ? 'up' : n(e.lower_tick) === 0 ? 'down' : 'range';
      const strike = isUp ? lower : higher;
      const won = shape === 'up' ? px > strike : shape === 'down' ? px <= strike : px > lower && px <= higher;
      const prob = n(e.entry_probability) / 1e9;
      const pq = n((e as V2OrderEvent).net_premium ?? (e as Record<string, unknown>).premium) / Math.max(1, n(e.quantity));
      rows.push({ owner: String(e.owner ?? '').toLowerCase(), at: n(e.checkpoint_timestamp_ms), id, shape, isUp, strike, lower, higher, prob, pq, left: mk.expiry - n(e.checkpoint_timestamp_ms), px, won, stake: n((e as V2OrderEvent).net_premium ?? (e as Record<string, unknown>).premium) / 1e6 });
    }
    console.log(`\n  ${mints.length} mints in the scan, ${rows.length} on settled markets (${settled.size} markets read)`);
    const bucket = (label: string, sel: (r: Row) => boolean) => {
      const rs = rows.filter(sel);
      if (!rs.length) return;
      const wins = rs.filter((r) => r.won).length;
      const exp = rs.reduce((a, r) => a + r.prob, 0) / rs.length;
      console.log(`  ${label.padEnd(26)} n=${String(rs.length).padStart(4)}  priced ${(exp * 100).toFixed(0).padStart(3)}%  won ${((wins / rs.length) * 100).toFixed(0).padStart(3)}%  (${wins}W/${rs.length - wins}L)`);
    };
    console.log('  --- by priced win chance ---');
    for (const [lo, hi] of [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) bucket(`${lo}-${hi}`, (r) => r.prob >= lo && r.prob < hi);
    console.log('  --- by side ---');
    bucket('UP', (r) => r.shape === 'up'); bucket('DOWN', (r) => r.shape === 'down'); bucket('RANGE', (r) => r.shape === 'range');
    bucket('UP    priced >= 70%', (r) => r.shape === 'up' && r.prob >= 0.7); bucket('DOWN  priced >= 70%', (r) => r.shape === 'down' && r.prob >= 0.7);
    bucket('RANGE priced >= 70%', (r) => r.shape === 'range' && r.prob >= 0.7); bucket('RANGE priced 50-70%', (r) => r.shape === 'range' && r.prob >= 0.5 && r.prob < 0.7);
    bucket('RANGE priced < 50%', (r) => r.shape === 'range' && r.prob < 0.5);
    console.log('  --- by time left at mint ---');
    for (const [lo, hi, l] of [[0, 60_000, '< 1 min'], [60_000, 180_000, '1-3 min'], [180_000, 600_000, '3-10 min'], [600_000, 1e12, '> 10 min']] as const) bucket(String(l), (r) => r.left >= lo && r.left < hi);
    bucket('>=70%, < 3 min left', (r) => r.prob >= 0.7 && r.left < 180_000);
    bucket('>=70%, >= 3 min left', (r) => r.prob >= 0.7 && r.left >= 180_000);
    const mism = rows.filter((r) => Math.abs(r.prob - r.pq) > 0.02).length;
    console.log(`  entry_probability vs premium/quantity: ${mism} of ${rows.length} differ by > 0.02`);
    console.log('\n  --- ours (deployer) ---');
    for (const r of rows.filter((r) => r.owner === OWNER).sort((a, b) => a.at - b.at)) {
      const what = r.shape === 'range' ? `RANGE ${r.lower.toFixed(0)}-${r.higher.toFixed(0)}` : `${r.shape.toUpperCase().padEnd(4)} ${r.strike.toFixed(0)}`;
      console.log(`  ${when(r.at)}  ${what}  priced ${(r.prob * 100).toFixed(0)}%  ${(r.left / 60000).toFixed(1).padStart(5)} min left  settled ${r.px.toFixed(2)}  ${r.won ? 'WON ' : 'LOST'}  $${r.stake.toFixed(2)}`);
    }
  }, 600_000);
});
