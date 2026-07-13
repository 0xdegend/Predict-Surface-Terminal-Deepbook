/**
 * Live end-to-end check for the vault-risk composition. Network-gated — runs only
 * with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/risk/v2.live.test.ts
 *
 * Mirrors what useV2Risk does (vault state + active markets + per-market OI +
 * flushes) but through the real getters and the real pure module, so it proves the
 * panel will show sane, self-consistent numbers against the live testnet vault —
 * not just that the arithmetic is right on fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  getVaultState,
  getVaultFlushes,
  getV2Markets,
  getMarketOpenInterest,
} from '@/lib/api/v2/client';
import { activeMarkets } from '@/lib/markets/v2-discovery';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { computeVaultRisk, sharePriceSeries, stressPoint } from './v2';
import type { V2OpenInterest } from '@/lib/api/v2/types';

const RUN = process.env.RUN_LIVE === '1';
const VAULT = predictV2Config.shared.poolVault;

describe.skipIf(!RUN)('vault risk (live testnet)', () => {
  it('composes a coherent risk view from the live vault', async () => {
    const [state, flushes, marketRows] = await Promise.all([
      getVaultState(VAULT),
      getVaultFlushes(VAULT, 200),
      getV2Markets(100),
    ]);
    const cur = state.current!;
    expect(cur).toBeTruthy();

    const markets = activeMarkets(marketRows);
    const oiEntries = await Promise.all(
      markets.map(async (m) => [m.expiry_market_id, await getMarketOpenInterest(m.expiry_market_id)] as const),
    );
    const oiByMarket = new Map<string, V2OpenInterest>(oiEntries);

    const snapshot = {
      poolValue: fromQuote(cur.pool_value),
      totalShares: fromQuote(cur.total_supply),
      idle: fromQuote(cur.idle_balance_after),
      deployed: fromQuote(cur.active_market_nav),
    };
    const risk = computeVaultRisk(snapshot, markets, oiByMarket, fromQuote);

    // Structural sanity — every figure the panel prints must be well-formed.
    expect(risk.sharePrice).toBeGreaterThan(0);
    expect(risk.utilization).toBeGreaterThanOrEqual(0);
    expect(risk.utilization).toBeLessThanOrEqual(1.0001);
    expect(risk.headroom).toBeGreaterThanOrEqual(0);
    expect(risk.headroom).toBeLessThanOrEqual(1.0001);
    expect(risk.maxPayoutAtRisk).toBeGreaterThanOrEqual(0);
    // Exposure rows reconcile with the book total.
    const rowSum = risk.exposures.reduce((s, e) => s + e.maxPayout, 0);
    expect(rowSum).toBeCloseTo(risk.maxPayoutAtRisk, 6);
    // Coverage: a real testnet pool of ~10M vs a tiny book is astronomically safe.
    if (risk.maxPayoutAtRisk > 0) {
      expect(risk.coverage).toBe(snapshot.poolValue / risk.maxPayoutAtRisk);
      // Worst case drains to exactly (1 − 1/coverage) of NAV.
      const worst = stressPoint(risk, 1);
      expect(worst.poolValueAfter / snapshot.poolValue).toBeCloseTo(1 - 1 / risk.coverage, 6);
    }

    const series = sharePriceSeries(flushes, fromQuote);
    expect(series.length).toBeGreaterThan(1);
    // Oldest-first and every point positive.
    for (let i = 1; i < series.length; i++) {
      expect(series[i].timestamp_ms).toBeGreaterThanOrEqual(series[i - 1].timestamp_ms);
      expect(series[i].share_price).toBeGreaterThan(0);
    }

    console.log(
      `pool ${snapshot.poolValue.toFixed(2)} · share ${risk.sharePrice.toFixed(6)} · ` +
        `util ${(risk.utilization * 100).toFixed(2)}% · free ${(risk.headroom * 100).toFixed(2)}% · ` +
        `at-risk ${risk.maxPayoutAtRisk.toFixed(2)} · coverage ${
          Number.isFinite(risk.coverage) ? risk.coverage.toFixed(0) + '×' : '∞'
        } · ${risk.exposures.length} exposed markets · ${series.length} flush points`,
    );
  }, 45_000);
});
