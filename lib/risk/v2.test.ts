import { describe, it, expect } from 'vitest';
import {
  computeVaultRisk,
  stressPoint,
  stressCurve,
  sharePriceSeries,
  type VaultSnapshot,
} from './v2';
import { fromQuote } from '@/config/scale';
import type { V2Market, V2OpenInterest } from '@/lib/api/v2/types';

// Figures pulled live 2026-07-13 from the testnet vault + a market's open-interest.
const snapshot: VaultSnapshot = {
  poolValue: 10_007_417.92,
  totalShares: 10_000_010,
  idle: 9_558_625.42,
  deployed: 439_067.02,
};

const mkt = (id: string, expiry: number): V2Market =>
  ({ expiry_market_id: id, expiry }) as unknown as V2Market;

const oi = (count: number, qtyBase: string, floorBase = '0'): V2OpenInterest => ({
  expiry_market_id: 'x',
  open_order_count: count,
  open_quantity: qtyBase,
  open_floor_shares: floorBase,
});

describe('computeVaultRisk', () => {
  const markets = [mkt('0xA', 2_000), mkt('0xB', 1_000), mkt('0xC', 3_000)];
  const oiMap = new Map<string, V2OpenInterest>([
    ['0xA', oi(6, '75600000')], // 75.6 DUSDC — the real market #2
    ['0xB', oi(2, '24400000')], // 24.4
    ['0xC', oi(0, '0')], // no open orders → excluded
  ]);
  const risk = computeVaultRisk(snapshot, markets, oiMap, fromQuote);

  it('derives share price, utilization and headroom from the snapshot', () => {
    expect(risk.sharePrice).toBeCloseTo(1.000741, 5);
    expect(risk.utilization).toBeCloseTo(439_067.02 / 10_007_417.92, 6); // ~4.4%
    expect(risk.headroom).toBeCloseTo(9_558_625.42 / 10_007_417.92, 6); // ~95.5%
  });

  it('sums max payout at risk only over markets with open orders', () => {
    expect(risk.maxPayoutAtRisk).toBeCloseTo(100.0, 6); // 75.6 + 24.4, 0xC excluded
    expect(risk.exposures).toHaveLength(2);
  });

  it('coverage is pool value over gross max payout (a huge, safe multiple here)', () => {
    expect(risk.coverage).toBeCloseTo(10_007_417.92 / 100, 2);
    expect(risk.coverage).toBeGreaterThan(1); // solvent
  });

  it('orders exposures largest-first with each market’s share of the book', () => {
    expect(risk.exposures[0].marketId).toBe('0xA');
    expect(risk.exposures[0].maxPayout).toBeCloseTo(75.6, 6);
    expect(risk.exposures[0].share).toBeCloseTo(0.756, 6);
    expect(risk.exposures[1].share).toBeCloseTo(0.244, 6);
    expect(risk.exposures[0].share + risk.exposures[1].share).toBeCloseTo(1, 9);
  });

  it('reports infinite coverage when nothing is at risk', () => {
    const clean = computeVaultRisk(snapshot, markets, new Map(), fromQuote);
    expect(clean.maxPayoutAtRisk).toBe(0);
    expect(clean.coverage).toBe(Infinity);
    expect(clean.exposures).toEqual([]);
  });
});

describe('stressPoint / stressCurve', () => {
  // A deliberately tight pool so the stress actually bites: 100 NAV, 40 idle,
  // 100 shares, 80 max payout at risk → coverage 1.25×.
  const risk = computeVaultRisk(
    { poolValue: 100, totalShares: 100, idle: 40, deployed: 60 },
    [mkt('0xA', 1)],
    new Map([['0xA', oi(3, '80000000')]]),
    fromQuote,
  );

  it('no stress is a no-op', () => {
    const p = stressPoint(risk, 0);
    expect(p.outflow).toBe(0);
    expect(p.sharePriceAfter).toBeCloseTo(1, 9);
    expect(p.sharePriceChangePct).toBeCloseTo(0, 9);
    expect(p.breachesIdle).toBe(false);
  });

  it('pays out the stressed fraction of the book and marks the share price down', () => {
    const p = stressPoint(risk, 0.5); // half the 80 max payout = 40 outflow
    expect(p.outflow).toBeCloseTo(40, 9);
    expect(p.poolValueAfter).toBeCloseTo(60, 9);
    expect(p.sharePriceAfter).toBeCloseTo(0.6, 9);
    expect(p.sharePriceChangePct).toBeCloseTo(-0.4, 9);
    // 40 outflow == 40 idle exactly → not yet a breach (strictly greater).
    expect(p.breachesIdle).toBe(false);
  });

  it('flags when the outflow exceeds the idle buffer', () => {
    expect(stressPoint(risk, 0.6).breachesIdle).toBe(true); // 48 > 40 idle
  });

  it('the worst case (every bet wins) drains the pool to the coverage ratio', () => {
    const worst = stressPoint(risk, 1);
    expect(worst.outflow).toBeCloseTo(80, 9);
    expect(worst.poolValueAfter).toBeCloseTo(20, 9); // 100 − 80, still solvent (coverage 1.25×)
    // At coverage = 1 the pool would hit exactly 0; here coverage 1.25 leaves 20% NAV.
    expect(worst.poolValueAfter / risk.snapshot.poolValue).toBeCloseTo(1 - 1 / risk.coverage, 9);
  });

  it('clamps out-of-range adverse fractions', () => {
    expect(stressPoint(risk, -1).adverse).toBe(0);
    expect(stressPoint(risk, 5).adverse).toBe(1);
  });

  it('stressCurve spans 0..1 inclusive', () => {
    const curve = stressCurve(risk, 10);
    expect(curve).toHaveLength(11);
    expect(curve[0].adverse).toBe(0);
    expect(curve[curve.length - 1].adverse).toBe(1);
  });
});

describe('sharePriceSeries', () => {
  it('turns flushes into an oldest-first share-price series, dropping pre-seed rows', () => {
    const flushes = [
      { checkpoint_timestamp_ms: 3000, pool_value: '10007417920669', total_supply: '10000010000000' },
      { checkpoint_timestamp_ms: 1000, pool_value: '10000000000000', total_supply: '10000000000000' },
      { checkpoint_timestamp_ms: 2000, pool_value: '10003000000000', total_supply: '10000000000000' },
      { checkpoint_timestamp_ms: 500, pool_value: '5000000000', total_supply: '0' }, // pre-seed, dropped
    ];
    const series = sharePriceSeries(flushes, fromQuote);
    expect(series.map((p) => p.timestamp_ms)).toEqual([1000, 2000, 3000]); // sorted, seed gone
    expect(series[0].share_price).toBeCloseTo(1, 9);
    expect(series[2].share_price).toBeCloseTo(1.000741, 5);
    expect(series[2].vault_value).toBeCloseTo(10_007_417.92, 2);
  });

  it('is empty when every flush pre-dates the first share', () => {
    expect(sharePriceSeries([{ checkpoint_timestamp_ms: 1, pool_value: '1', total_supply: '0' }], fromQuote)).toEqual(
      [],
    );
  });
});
