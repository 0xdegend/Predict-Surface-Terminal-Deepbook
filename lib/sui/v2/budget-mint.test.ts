import { describe, it, expect } from 'vitest';
import { planBinaryBudgetMint, planRangeBudgetMint } from './budget-mint';
import { leverageScaled } from './ticks';
import { MIN_STAKE_BASE } from './quote';
import { toQuote } from '@/config/scale';
import type { SviFloat } from '@/lib/svi/svi';
import type { V2Market } from '@/lib/api/v2/types';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 65_000;

// A minimal market with just the fields the planner reads.
const market = {
  expiry_market_id: 'm1',
  admission_tick_size: '1000000000', // $1 grid (1e9-scaled)
  tick_size: '1',
  max_admission_leverage: 3_000_000_000, // 3x
  base_fee: '0',
} as unknown as V2Market;

const plan = (over: Partial<Parameters<typeof planBinaryBudgetMint>[0]> = {}) =>
  planBinaryBudgetMint({ market, forward: FORWARD, svi: SVI, strikePrice: FORWARD, isUp: true, stake: 10, leverage: 1, ...over });

describe('planBinaryBudgetMint', () => {
  it('sizes a near-the-money bet into ready mint params', () => {
    const p = plan();
    expect(p.probOk).toBe(true);
    expect(p.stakeOk).toBe(true);
    expect(p.entryProb).toBeGreaterThan(0.3);
    expect(p.entryProb).toBeLessThan(0.7);
    expect(p.stakeBase).toBe(toQuote(10));
    // The deposit ceiling covers stake + fee + slippage headroom.
    expect(p.maxCost).toBeGreaterThan(p.stakeBase);
    expect(p.mint.marketId).toBe('m1');
    expect(p.mint.leverage).toBe(leverageScaled(1));
    expect(p.mint.amount).toBeGreaterThan(0n);
    expect(p.mint.minQuantity).toBeGreaterThan(0n);
  });

  it('defaults to the at-the-money strike when none is given', () => {
    const p = plan({ strikePrice: null });
    expect(p.strike).toBeCloseTo(FORWARD, -1); // snapped to the $1 grid
  });

  it('caps leverage at the strike\'s admission ceiling', () => {
    const p = plan({ leverage: 99 });
    expect(p.lev).toBeLessThanOrEqual(p.maxLev);
    expect(p.mint.leverage).toBe(leverageScaled(p.lev));
  });

  it('flags a strike far from spot as not quotable', () => {
    const p = plan({ strikePrice: 90_000 }); // way above → ~0% for UP
    expect(p.probOk).toBe(false);
  });

  it('flags a sub-$1 stake as below the minimum', () => {
    const p = plan({ stake: 0.5 });
    expect(p.stakeOk).toBe(false);
    expect(p.stakeBase).toBeLessThan(MIN_STAKE_BASE);
  });
});

const rangePlan = (over: Partial<Parameters<typeof planRangeBudgetMint>[0]> = {}) =>
  planRangeBudgetMint({ market, forward: FORWARD, svi: SVI, lower: 64_000, higher: 66_000, stake: 10, leverage: 1, ...over });

describe('planRangeBudgetMint', () => {
  it('sizes a band around the forward into ready mint params', () => {
    const p = rangePlan();
    expect(p.probOk).toBe(true);
    expect(p.stakeOk).toBe(true);
    // A band straddling the forward should have a real chance of landing inside.
    expect(p.entryProb).toBeGreaterThan(0);
    expect(p.entryProb).toBeLessThan(1);
    expect(p.lower).toBeCloseTo(64_000, -1); // snapped to the $1 grid
    expect(p.higher).toBeCloseTo(66_000, -1);
    expect(p.stakeBase).toBe(toQuote(10));
    expect(p.maxCost).toBeGreaterThan(p.stakeBase);
    expect(p.mint.marketId).toBe('m1');
    expect(p.mint.leverage).toBe(leverageScaled(1));
    expect(p.mint.amount).toBeGreaterThan(0n);
    expect(p.mint.minQuantity).toBeGreaterThan(0n);
  });

  it('orders the band edges regardless of input order', () => {
    const p = rangePlan({ lower: 66_000, higher: 64_000 });
    expect(p.lower).toBeLessThan(p.higher);
  });

  it('caps leverage at the band\'s admission ceiling', () => {
    const p = rangePlan({ leverage: 99 });
    expect(p.lev).toBeLessThanOrEqual(p.maxLev);
    expect(p.mint.leverage).toBe(leverageScaled(p.lev));
  });

  it('flags a band far from spot as not quotable', () => {
    const p = rangePlan({ lower: 90_000, higher: 92_000 }); // way above → ~0% inside
    expect(p.probOk).toBe(false);
  });

  it('flags a sub-$1 stake as below the minimum', () => {
    const p = rangePlan({ stake: 0.5 });
    expect(p.stakeOk).toBe(false);
    expect(p.stakeBase).toBeLessThan(MIN_STAKE_BASE);
  });
});
