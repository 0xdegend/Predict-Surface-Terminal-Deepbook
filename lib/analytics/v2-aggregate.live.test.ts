/**
 * Live end-to-end check for the analytics aggregation. Network-gated — runs only
 * with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/analytics/v2-aggregate.live.test.ts
 *
 * Mirrors what useV2Analytics does (fan the per-market ORDERS feed out across a
 * RECENT window of markets — active + just-expired — fold into cells / sentiment
 * / flow / KPIs) through the real getters and the real pure module — proving the
 * Analytics page shows coherent REAL numbers against the live testnet.
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets, getMarketOrders, getMarketOpenInterest } from '@/lib/api/v2/client';
import { recentMarkets } from '@/lib/markets/v2-discovery';
import {
  flowRows,
  marketCells,
  kpisFromData,
  sentimentFromOrders,
  type MarketInputs,
} from './v2-aggregate';
import { classifyV2Traders } from './v2-trader-style';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const RUN = process.env.RUN_LIVE === '1';

describe.skipIf(!RUN)('v2 analytics aggregate (live testnet)', () => {
  it('reconstructs coherent flow / sentiment / cells / KPIs from the live feeds', async () => {
    const now = Date.now();
    // Recent window (active + expired within 20 min) for the order pool.
    const markets = recentMarkets(await getV2Markets(200), 20 * 60_000, now).slice(0, 30);
    expect(markets.length).toBeGreaterThan(0);
    const active = markets.filter((m) => m.expiry > now);

    const ordersByMarket = new Map<string, V2OrderEvent[]>();
    await Promise.all(
      markets.map(async (m) => {
        ordersByMarket.set(m.expiry_market_id, await getMarketOrders(m.expiry_market_id, 60));
      }),
    );
    // Per-market cell inputs for the LIVE markets only (OI from the live feed).
    const inputs = new Map<string, MarketInputs>();
    await Promise.all(
      active.map(async (m) => {
        const oi = await getMarketOpenInterest(m.expiry_market_id);
        inputs.set(m.expiry_market_id, { orders: ordersByMarket.get(m.expiry_market_id), oi: oi.open_order_count });
      }),
    );

    const cells = marketCells(active, inputs, 63_000);
    const flow = flowRows(ordersByMarket, markets);
    const allOrders = [...ordersByMarket.values()].flat();
    const kpis = kpisFromData(allOrders, active.length);
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
    // The recent order pool spans a wider window than the live cells, so its
    // total is at least the live cells' summed volume (⊇), never less.
    expect(kpis.totalBet).toBeGreaterThanOrEqual(cells.reduce((s, c) => s + c.volume, 0) - 1e-6);
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
      `recent markets ${markets.length} (${active.length} live) · recent volume ${kpis.totalBet.toFixed(2)} DUSDC · ` +
        `biggest ${kpis.biggestBet.toFixed(2)} · sentiment ${(sentiment.upShare * 100).toFixed(1)}% UP ` +
        `(${sentiment.upCount}↑ / ${sentiment.downCount}↓) · ${flow.length} recent bets`,
    );
    const top = cells[0];
    if (top) console.log(`top market ${top.marketId.slice(0, 10)}… vol ${top.volume.toFixed(2)} · ${top.bets} bets · ${top.oi} open`);

    // Trader styles from the same feeds — every classified trader is real + valid.
    const styles = classifyV2Traders(ordersByMarket);
    expect(styles.distribution.reduce((s, d) => s + d.count, 0)).toBe(styles.total);
    for (let i = 1; i < styles.traders.length; i++) {
      expect(styles.traders[i - 1].volume).toBeGreaterThanOrEqual(styles.traders[i].volume);
    }
    for (const t of styles.traders) {
      expect(t.owner).toMatch(/^0x[0-9a-f]+/);
      expect(t.style.primary).not.toBeNull();
      expect(t.volume).toBeGreaterThan(0);
    }
    console.log(
      `traders classified ${styles.total} · ${styles.distribution.map((d) => `${d.label} ${d.count}`).join(' · ')}`,
    );
  }, 60_000);
});
