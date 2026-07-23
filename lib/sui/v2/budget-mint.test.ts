import { describe, it, expect } from 'vitest';
import { planBinaryBudgetMint } from './budget-mint';
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
