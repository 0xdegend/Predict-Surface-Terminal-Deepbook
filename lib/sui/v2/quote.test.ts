import { describe, it, expect } from 'vitest';
import { quantityForStake, defaultRangeBandOffsets } from './quote';
import { rangeFair, type SviFloat } from '@/lib/svi/svi';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 63_000;
const STEP = 1; // $1 admission tick (float)

describe('quantityForStake', () => {
  it('at 1x, cost ≈ stake (quantity = stake / prob)', () => {
    const stakeBase = 10_000_000n; // $10
    const q = quantityForStake(stakeBase, 0.5, 1);
    expect(Number(q)).toBeCloseTo(20_000_000, -3); // $10 / 0.5 = $20 max payout
  });
  it('leverage scales the controllable size', () => {
    const q1 = quantityForStake(10_000_000n, 0.5, 1);
    const q3 = quantityForStake(10_000_000n, 0.5, 3);
    expect(Number(q3)).toBeCloseTo(Number(q1) * 3, -3);
  });
});

describe('defaultRangeBandOffsets', () => {
  const nowMs = 1_000_000_000;
  const expiryMs = nowMs + 60 * 60_000; // 1h out

  it('produces a non-degenerate band straddling ATM', () => {
    const { lower, higher } = defaultRangeBandOffsets(FORWARD, FORWARD, SVI, expiryMs, nowMs, STEP);
    expect(higher).toBeGreaterThan(lower);
    expect(lower).toBeLessThan(0);
    expect(higher).toBeGreaterThan(0);
  });

  it('the default band is a plausible, quotable chance (not ~0% or ~100%)', () => {
    const { lower, higher } = defaultRangeBandOffsets(FORWARD, FORWARD, SVI, expiryMs, nowMs, STEP);
    const chance = rangeFair(FORWARD + lower * STEP, FORWARD + higher * STEP, FORWARD, SVI);
    expect(chance).toBeGreaterThan(0.1);
    expect(chance).toBeLessThan(0.9);
  });

  it('a higher-variance SVI gives a wider band (width tracks √w, not √T)', () => {
    const calm = defaultRangeBandOffsets(FORWARD, FORWARD, SVI, expiryMs, nowMs, STEP);
    const wild = defaultRangeBandOffsets(FORWARD, FORWARD, { ...SVI, a: SVI.a * 4, b: SVI.b * 4 }, expiryMs, nowMs, STEP);
    expect(wild.higher - wild.lower).toBeGreaterThan(calm.higher - calm.lower);
  });

  it('holding SVI constant, band width is tenor-invariant (σ = forward·√w — √T cancels)', () => {
    const shortB = defaultRangeBandOffsets(FORWARD, FORWARD, SVI, nowMs + 5 * 60_000, nowMs, STEP);
    const longB = defaultRangeBandOffsets(FORWARD, FORWARD, SVI, nowMs + 120 * 60_000, nowMs, STEP);
    expect(longB.higher - longB.lower).toBe(shortB.higher - shortB.lower);
  });
});
