/**
 * my-record.live.test.ts — one wallet's own settled bets, scored against what it paid.
 *
 *   OWNER=0x… NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
 *     npx vitest run lib/autopilot/my-record.live.test.ts
 *
 * Built 2026-09-07 for "I keep telling Kelly to play it careful and I keep losing". The
 * venue-wide read (venue-calibration.live.test) said high-priced binaries lose money; this
 * asks whether THIS trader's own record says the same thing, because a rule change should
 * be argued from the trades they actually have.
 *
 * Scans the owner AND every delegated session key (Autopilot fires from a session key, so
 * an owner-only scan would miss the very trades in question), joins each mint to its
 * market's settlement, and reports realized return per $1 staked next to win rate. Those
 * two numbers point in opposite directions above ~70% priced, which is the whole point.
 * Reads only.
 */
import { describe, it } from 'vitest';
import { onchainOwnerOrders, onchainMarketState } from '@/lib/api/v2/onchain';
import { toFloat } from '@/config/scale';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const RUN = process.env.RUN_LIVE === '1';
const OWNER = process.env.OWNER ?? '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';
const n = (v: unknown) => Number(v ?? 0);

type Shape = 'up' | 'down' | 'range';
type Row = {
  at: number; shape: Shape; strike: number; lower: number; higher: number;
  prob: number; leftMs: number; px: number; won: boolean; stake: number; ret: number;
};

describe.skipIf(!RUN)('my own settled record', () => {
  it('scores every settled bet by what it paid, not just whether it won', async () => {
    const orders = await onchainOwnerOrders(OWNER, 400);
    const mints = orders.filter((o) => String(o.kind ?? '').includes('mint'));
    const ids = [...new Set(mints.map((m) => String(m.expiry_market_id)))];
    console.log(`\n  ${orders.length} order events, ${mints.length} mints, ${ids.length} markets`);

    const mk = new Map<string, { expiry: number; tick: number }>();
    const settled = new Map<string, number>();
    for (const id of ids) {
      try {
        const st = await onchainMarketState(id);
        mk.set(id, { expiry: st.market.expiry, tick: toFloat(BigInt(st.market.tick_size)) });
        const raw = st.settlement?.settlement_price;
        if (raw != null) settled.set(id, toFloat(BigInt(raw)));
      } catch { /* unreadable market — skip */ }
    }

    const rows: Row[] = [];
    for (const e of mints) {
      const id = String(e.expiry_market_id);
      const m = mk.get(id); const px = settled.get(id);
      if (!m || px == null) continue;
      const isUp = BigInt(e.higher_tick ?? 0) === POS_INF_TICK;
      const lower = n(e.lower_tick) * m.tick;
      const higher = n(e.higher_tick) * m.tick;
      const shape: Shape = isUp ? 'up' : n(e.lower_tick) === 0 ? 'down' : 'range';
      const strike = isUp ? lower : higher;
      const won = shape === 'up' ? px > strike : shape === 'down' ? px <= strike : px > lower && px <= higher;
      const prob = n(e.entry_probability) / 1e9;
      const stake = n((e as V2OrderEvent).net_premium ?? (e as Record<string, unknown>).premium) / 1e6;
      const at = n(e.checkpoint_timestamp_ms);
      // A unit stake returns (1 - price)/price on a win and -1 on a loss. `prob` IS the
      // price paid per unit, so this is the realized return on the money risked.
      rows.push({ at, shape, strike, lower, higher, prob, leftMs: m.expiry - at, px, won, stake, ret: won ? (1 - prob) / prob : -1 });
    }
    rows.sort((a, b) => a.at - b.at);

    const bucket = (label: string, sel: (r: Row) => boolean) => {
      const rs = rows.filter(sel);
      if (!rs.length) return;
      const w = rs.filter((r) => r.won).length;
      const roi = rs.reduce((a, r) => a + r.ret, 0) / rs.length;
      const pnl = rs.reduce((a, r) => a + r.stake * r.ret, 0);
      const staked = rs.reduce((a, r) => a + r.stake, 0);
      console.log(
        `  ${label.padEnd(28)} n=${String(rs.length).padStart(3)}  priced ${((rs.reduce((a, r) => a + r.prob, 0) / rs.length) * 100).toFixed(0).padStart(3)}%` +
          `  won ${((w / rs.length) * 100).toFixed(0).padStart(3)}%  return ${((roi >= 0 ? '+' : '') + (roi * 100).toFixed(1)).padStart(7)}%/$1` +
          `  staked $${staked.toFixed(0).padStart(5)}  net ${(pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2)}`,
      );
    };

    console.log(`\n  ${rows.length} settled bets`);
    bucket('ALL', () => true);
    console.log('  --- by priced win chance ---');
    for (const [lo, hi] of [[0, 0.5], [0.5, 0.6], [0.6, 0.68], [0.68, 0.8], [0.8, 1.01]])
      bucket(`priced ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`, (r) => r.prob >= lo && r.prob < hi);
    console.log('  --- the Careful floor, split at 0.70 ---');
    bucket('priced >= 70% (Careful)', (r) => r.prob >= 0.7);
    bucket('priced < 70% (blocked)', (r) => r.prob < 0.7);
    console.log('  --- by shape ---');
    for (const s of ['up', 'down', 'range'] as Shape[]) bucket(s.toUpperCase(), (r) => r.shape === s);
    console.log('  --- by time left at mint ---');
    for (const [lo, hi, l] of [[0, 60_000, '< 1 min'], [60_000, 180_000, '1-3 min'], [180_000, 900_000, '3-15 min'], [900_000, 1e12, '> 15 min']] as const)
      bucket(String(l), (r) => r.leftMs >= lo && r.leftMs < hi);

    console.log('\n  --- every settled bet, oldest first ---');
    for (const r of rows) {
      const what = r.shape === 'range' ? `RANGE ${r.lower.toFixed(0)}-${r.higher.toFixed(0)}` : `${r.shape.toUpperCase().padEnd(4)} ${r.strike.toFixed(0)}`;
      console.log(
        `  ${new Date(r.at).toISOString().slice(5, 16).replace('T', ' ')}  ${what.padEnd(22)} priced ${(r.prob * 100).toFixed(0).padStart(3)}%` +
          ` ${(r.leftMs / 60000).toFixed(1).padStart(6)}m left  settled ${r.px.toFixed(0)}  ${r.won ? 'WON ' : 'LOST'}` +
          ` $${r.stake.toFixed(2).padStart(8)}  ${(r.ret >= 0 ? '+$' : '-$') + Math.abs(r.stake * r.ret).toFixed(2)}`,
      );
    }
  }, 900_000);
});
