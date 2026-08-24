import { describe, it, expect } from 'vitest';
import { buildHouseBook, houseStanding, STRONG_COVERAGE, STRETCHED_COVERAGE } from './house-book';
import type { VaultRisk, MarketExposure } from '@/lib/risk/v2';

const exposure = (marketId: string, maxPayout: number, share: number, orders = 4): MarketExposure => ({
  marketId,
  expiry: 1_700_000_000_000,
  orders,
  maxPayout,
  floor: maxPayout * 0.2,
  share,
});

function risk(over: Partial<VaultRisk> = {}): VaultRisk {
  const base: VaultRisk = {
    snapshot: { poolValue: 100_000, totalShares: 100_000, idle: 60_000, deployed: 40_000 },
    sharePrice: 1,
    utilization: 0.4,
    headroom: 0.6,
    maxPayoutAtRisk: 10_000,
    coverage: 10,
    exposures: [exposure('m1', 6_000, 0.6), exposure('m2', 4_000, 0.4)],
  };
  return { ...base, ...over };
}

describe('houseStanding', () => {
  it('is strong with deep coverage and a quiet pool', () => {
    expect(houseStanding(STRONG_COVERAGE + 1, 0.3)).toBe('strong');
  });

  it('is stretched when coverage is thin, however quiet the pool', () => {
    expect(houseStanding(STRETCHED_COVERAGE - 0.1, 0.05)).toBe('stretched');
  });

  it('is stretched when most of the pool is committed, however deep the coverage', () => {
    expect(houseStanding(50, 0.8)).toBe('stretched');
  });

  it('sits at normal between the two', () => {
    expect(houseStanding(3, 0.5)).toBe('normal');
  });
});

describe('buildHouseBook', () => {
  it('returns null without a pool, so the panel is absent rather than zeroed', () => {
    expect(buildHouseBook(null, 'm1')).toBeNull();
    expect(buildHouseBook(risk({ snapshot: { poolValue: 0, totalShares: 0, idle: 0, deployed: 0 } }), 'm1')).toBeNull();
  });

  it('carries the pool figures through unchanged', () => {
    const h = buildHouseBook(risk(), 'm1')!;
    expect(h.poolUsd).toBe(100_000);
    expect(h.idleUsd).toBe(60_000);
    expect(h.atWork).toBeCloseTo(0.4);
    expect(h.atRiskUsd).toBe(10_000);
    expect(h.coverage).toBe(10);
  });

  it('finds the selected market slice', () => {
    const h = buildHouseBook(risk(), 'm2')!;
    expect(h.here).toEqual({ atRiskUsd: 4_000, share: 0.4, orders: 4 });
  });

  it('has no slice for a market with no open interest', () => {
    const h = buildHouseBook(risk(), 'not-listed')!;
    expect(h.here).toBeNull();
    expect(h.summary).toContain('Nothing open on this expiry yet');
  });

  it('has no slice when no market is selected', () => {
    expect(buildHouseBook(risk(), null)!.here).toBeNull();
  });

  it('says the house is flat when nothing is at risk anywhere', () => {
    const h = buildHouseBook(risk({ maxPayoutAtRisk: 0, coverage: Infinity, exposures: [] }), 'm1')!;
    expect(h.summary).toContain('nothing at risk yet');
    // An idle pool must not read as depth.
    expect(h.summary).not.toContain('cover every open bet');
  });

  it('describes a thin pool as carrying a lot rather than as covered', () => {
    const h = buildHouseBook(risk({ coverage: 1.4, maxPayoutAtRisk: 71_000, utilization: 0.9 }), 'm1')!;
    expect(h.standing).toBe('stretched');
    expect(h.summary).toContain('carrying a lot');
  });

  it('sizes the slice in words, by share', () => {
    const big = buildHouseBook(risk({ exposures: [exposure('m1', 9_000, 0.9)] }), 'm1')!;
    expect(big.summary).toContain('Most of that');

    const mid = buildHouseBook(risk({ exposures: [exposure('m1', 2_500, 0.25)] }), 'm1')!;
    expect(mid.summary).toContain('A good slice');

    const small = buildHouseBook(risk({ exposures: [exposure('m1', 500, 0.05)] }), 'm1')!;
    expect(small.summary).toContain('A small part');
  });

  it('rounds coverage coarsely once it is deep, and finely when it is not', () => {
    expect(buildHouseBook(risk({ coverage: 12.4 }), 'm1')!.summary).toContain('12 times over');
    expect(buildHouseBook(risk({ coverage: 3.25 }), 'm1')!.summary).toContain('3.3 times over');
    expect(buildHouseBook(risk({ coverage: 250 }), 'm1')!.summary).toContain('many times over');
  });

  it('pluralises the open-bet count', () => {
    expect(buildHouseBook(risk({ exposures: [exposure('m1', 1_000, 0.1, 1)] }), 'm1')!.summary).toContain('1 open bet.');
    expect(buildHouseBook(risk({ exposures: [exposure('m1', 1_000, 0.1, 3)] }), 'm1')!.summary).toContain('3 open bets.');
  });
});
