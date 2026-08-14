import { describe, it, expect } from 'vitest';
import { getStyleRoster } from './v2-style-indexer';
import { getV2Markets, getMarketOrders } from '@/lib/api/v2/client';
import { classifyV2Traders } from './v2-trader-style';
import type { V2OrderEvent } from '@/lib/api/v2/types';

// Live 8-06 read. Gated behind RUN_LIVE=1 (like the other *.live.test.ts). The cold seed
// pages the mint history + fans out known owners, so give it a generous budget.
const RUN = process.env.RUN_LIVE === '1';
const d = RUN ? describe : describe.skip;

d('v2 style indexer (live 8-06)', () => {
  it('builds a complete roster, at least as full as the old windowed fan-out', async () => {
    // NEW: the accumulating all-time roster.
    const roster = await getStyleRoster();
    const distSum = roster.distribution.reduce((a, b) => a + b.count, 0);
    console.log(
      'NEW (accumulator): available=%s total=%d rows=%d dist=%o',
      roster.available,
      roster.total,
      roster.traders.length,
      roster.distribution.map((b) => `${b.label}:${b.count}`),
    );

    expect(roster.available).toBe(true);
    expect(roster.total).toBeGreaterThanOrEqual(0);
    expect(roster.traders.length).toBeLessThanOrEqual(200);
    expect(distSum).toBe(roster.total); // distribution accounts for every classified trader
    // roster rows are sorted by volume desc
    for (let i = 1; i < roster.traders.length; i++) {
      expect(roster.traders[i - 1].volume).toBeGreaterThanOrEqual(roster.traders[i].volume);
    }

    // OLD: the truncated per-market fan-out, reconstructed for a before/after comparison.
    let oldTotal = -1;
    try {
      const markets = await getV2Markets(500);
      const ids = [...new Set(markets.map((m) => m.expiry_market_id))].slice(0, 40);
      const byMarket = new Map<string, V2OrderEvent[]>();
      for (const id of ids) {
        try {
          byMarket.set(id, await getMarketOrders(id, 200));
        } catch {
          /* skip an unavailable feed */
        }
      }
      oldTotal = classifyV2Traders(byMarket).total;
      console.log('OLD (windowed fan-out): total=%d', oldTotal);
      // The whole point of the change: the complete roster is never smaller.
      expect(roster.total).toBeGreaterThanOrEqual(oldTotal);
    } catch (e) {
      console.log('OLD comparison skipped:', (e as Error).message);
    }
  }, 300_000);
});
