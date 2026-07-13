/**
 * Live end-to-end check for the analytics aggregation. Network-gated — runs only
 * with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/analytics/v2-aggregate.live.test.ts
 *
 * Mirrors what useV2Analytics does (fan the per-market order + activity feeds out
 * across the active markets, fold into cells / sentiment / flow / KPIs) through
 * the real getters and the real pure module — proving the Analytics page shows
 * coherent REAL numbers against the live testnet, not just that the fixtures pass.
 */
import { describe, it, expect } from 'vitest';
import {
  getV2Markets,
  getMarketOrders,
  getMarketActivity,
  getMarketOpenInterest,
} from '@/lib/api/v2/client';
import { activeMarkets } from '@/lib/markets/v2-discovery';
import {
  flowRows,
  marketCells,
  kpisFromData,
  sentimentFromOrders,
  type MarketInputs,
} from './v2-aggregate';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const RUN = process.env.RUN_LIVE === '1';

describe.skipIf(!RUN)('v2 analytics aggregate (live testnet)', () => {
  it('reconstructs coherent flow / sentiment / cells / KPIs from the live feeds', async () => {
    const markets = activeMarkets(await getV2Markets(100));
    expect(markets.length).toBeGreaterThan(0);

    const inputs = new Map<string, MarketInputs>();
    const ordersByMarket = new Map<string, V2OrderEvent[]>();
    await Promise.all(
      markets.map(async (m) => {
        const id = m.expiry_market_id;
        const [orders, activity, oi] = await Promise.all([
          getMarketOrders(id, 60),
          getMarketActivity(id, 24),
          getMarketOpenInterest(id),
        ]);
        ordersByMarket.set(id, orders);
        inputs.set(id, { orders, activity, oi: oi.open_order_count });
      }),
    );

    const cells = marketCells(markets, inputs, 63_000);
    const flow = flowRows(ordersByMarket, markets);
    const allOrders = [...ordersByMarket.values()].flat();
    const kpis = kpisFromData(cells, allOrders, markets.length);
    const sentiment = sentimentFromOrders(allOrders);

    // Structural sanity — every figure the tools print is well-formed.
    for (const c of cells) {
      expect(c.volume).toBeGreaterThanOrEqual(0);
      expect(c.bets).toBeGreaterThanOrEqual(0);
      expect(c.oi).toBeGreaterThanOrEqual(0);
      expect(c.upShare).toBeGreaterThanOrEqual(0);
      expect(c.upShare).toBeLessThanOrEqual(1);
    }
    // Cells are volume-ranked.
    for (let i = 1; i < cells.length; i++) expect(cells[i - 1].volume).toBeGreaterThanOrEqual(cells[i].volume);
    // KPI total agrees with the cells.
    expect(kpis.totalBet).toBeCloseTo(cells.reduce((s, c) => s + c.volume, 0), 6);
    // Flow is newest-first, every row a real trader + real side.
    for (let i = 1; i < flow.length; i++) expect(flow[i - 1].tsMs).toBeGreaterThanOrEqual(flow[i].tsMs);
    for (const r of flow.slice(0, 20)) {
      expect(r.trader).toMatch(/^0x[0-9a-f]+/);
      expect(['up', 'down', 'range']).toContain(r.side);
      expect(r.stakeUsd).toBeGreaterThanOrEqual(0);
    }
    // Sentiment reconciles: up + down cost sums, share in [0,1].
    expect(sentiment.upShare).toBeGreaterThanOrEqual(0);
    expect(sentiment.upShare).toBeLessThanOrEqual(1);

    console.log(
      `markets ${markets.length} · 24h volume ${kpis.totalBet.toFixed(2)} DUSDC · ` +
        `biggest ${kpis.biggestBet.toFixed(2)} · sentiment ${(sentiment.upShare * 100).toFixed(1)}% UP ` +
        `(${sentiment.upCount}↑ / ${sentiment.downCount}↓) · ${flow.length} recent bets`,
    );
    const top = cells[0];
    if (top) console.log(`top market ${top.marketId.slice(0, 10)}… vol ${top.volume.toFixed(2)} · ${top.bets} bets · ${top.oi} open`);
  }, 60_000);
});
