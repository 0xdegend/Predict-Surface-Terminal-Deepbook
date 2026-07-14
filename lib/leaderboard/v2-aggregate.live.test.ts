/**
 * Live end-to-end check for the Season-2 board. Network-gated — RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/leaderboard/v2-aggregate.live.test.ts
 *
 * Mirrors useV2Leaderboard (fan the per-market order feeds out across the FULL
 * retained market window, fold into ranked rows) through the real getters + the
 * real aggregate, proving the board shows coherent REAL standings against the
 * live testnet.
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets, getMarketOrders } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { aggregateV2Leaderboard } from './v2-aggregate';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

const RUN = process.env.RUN_LIVE === '1';
// The indexer's /markets ceiling — the whole retained universe (see the hook).
const CAP = 500;

describe.skipIf(!RUN)('v2 leaderboard (live testnet)', () => {
  it('reconstructs a coherent ranked board from the order feeds', async () => {
    const markets = (await getV2Markets(CAP)) as V2Market[];
    const byId = new Map<string, V2Market>();
    for (const m of markets) {
      const prev = byId.get(m.expiry_market_id);
      if (!prev || m.checkpoint_timestamp_ms > prev.checkpoint_timestamp_ms) byId.set(m.expiry_market_id, m);
    }
    const ids = [...byId.values()]
      .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
      .slice(0, CAP)
      .map((m) => m.expiry_market_id);

    const ordersByMarket = new Map<string, V2OrderEvent[]>();
    await Promise.all(
      ids.map(async (id) => {
        ordersByMarket.set(id, await getMarketOrders(id, 200));
      }),
    );

    const rows = aggregateV2Leaderboard(ordersByMarket, predictV2Config.builderCodeId, Date.now());

    // Ranked by points desc; every figure well-formed.
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].points).toBeGreaterThanOrEqual(rows[i].points);
    for (const r of rows) {
      expect(r.owner).toMatch(/^0x[0-9a-f]+/);
      expect(r.volume).toBeGreaterThanOrEqual(0);
      expect(r.trades).toBeGreaterThan(0);
      expect(r.points).toBeGreaterThanOrEqual(r.volume); // points ≥ liquidity component
      // Points ≈ volume + max(0,pnl)·2 + holding·0.1 — never less than volume.
    }
    const skew = rows.filter((r) => r.viaSkew);
    console.log(
      `board: ${rows.length} traders · top ${rows[0]?.owner.slice(0, 10)}… ` +
        `${rows[0]?.points.toFixed(0)} pts / ${rows[0]?.volume.toFixed(2)} vol / ${rows[0]?.trades} trades / pnl ${rows[0]?.netPnl?.toFixed(2)} · ` +
        `skew-attributed ${skew.length}`,
    );
  }, 60_000);
});
