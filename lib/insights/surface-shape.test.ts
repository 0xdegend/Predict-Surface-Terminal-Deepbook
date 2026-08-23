import { describe, it, expect } from 'vitest';
import { riskReversal, forwardBasisPct } from './surface-shape';
import type { SviFloat } from '@/lib/svi/svi';

const FORWARD = 64_000;
const NOW = 1_000_000_000_000;
const EXPIRY = NOW + 2 * 3_600_000;

/** rho < 0 tilts the smile toward puts, which is the usual crypto shape. */
const PUT_SKEWED: SviFloat = { a: 0.002, b: 0.01, rho: -0.4, m: 0, sigma: 0.08 };
const CALL_SKEWED: SviFloat = { ...PUT_SKEWED, rho: 0.4 };
const SYMMETRIC: SviFloat = { ...PUT_SKEWED, rho: 0 };

describe('riskReversal', () => {
  it('reads negative when puts are the dear side', () => {
    const rr = riskReversal({ forward: FORWARD, svi: PUT_SKEWED }, EXPIRY, NOW)!;
    expect(rr.rr25Pts).toBeLessThan(0);
    expect(rr.callIv).toBeLessThan(rr.putIv);
  });

  it('flips sign when the skew flips', () => {
    const rr = riskReversal({ forward: FORWARD, svi: CALL_SKEWED }, EXPIRY, NOW)!;
    expect(rr.rr25Pts).toBeGreaterThan(0);
  });

  it('is near flat on a symmetric smile, and grows with the skew', () => {
    // Not exactly zero even at rho = 0: the two sides are symmetric in PROBABILITY, and
    // the binary's drift term (d2 carries −w/2) puts them at slightly asymmetric strikes.
    // What matters is that it is an order of magnitude smaller than a real skew, and that
    // it tracks rho monotonically.
    const flat = riskReversal({ forward: FORWARD, svi: SYMMETRIC }, EXPIRY, NOW)!.rr25Pts;
    const mild = riskReversal({ forward: FORWARD, svi: { ...PUT_SKEWED, rho: -0.1 } }, EXPIRY, NOW)!.rr25Pts;
    const steep = riskReversal({ forward: FORWARD, svi: { ...PUT_SKEWED, rho: -0.6 } }, EXPIRY, NOW)!.rr25Pts;
    expect(Math.abs(flat)).toBeLessThan(1);
    expect(mild).toBeLessThan(flat);
    expect(steep).toBeLessThan(mild);
  });

  it('takes the two strikes either side of the forward', () => {
    const rr = riskReversal({ forward: FORWARD, svi: SYMMETRIC }, EXPIRY, NOW)!;
    // 25% chance ABOVE sits above the money; 75% chance above sits below it.
    expect(rr.callStrike).toBeGreaterThan(FORWARD);
    expect(rr.putStrike).toBeLessThan(FORWARD);
  });

  it('is null once the expiry is past, or the forward is degenerate', () => {
    expect(riskReversal({ forward: FORWARD, svi: SYMMETRIC }, NOW - 1, NOW)).toBeNull();
    expect(riskReversal({ forward: 0, svi: SYMMETRIC }, EXPIRY, NOW)).toBeNull();
  });
});

describe('forwardBasisPct', () => {
  it('is positive when the forward trades over spot', () => {
    expect(forwardBasisPct(64_320, 64_000)).toBeCloseTo(0.5, 6);
  });

  it('is negative in backwardation', () => {
    expect(forwardBasisPct(63_680, 64_000)).toBeCloseTo(-0.5, 6);
  });

  it('is null without both sides', () => {
    expect(forwardBasisPct(64_000, null)).toBeNull();
    expect(forwardBasisPct(0, 64_000)).toBeNull();
    expect(forwardBasisPct(64_000, 0)).toBeNull();
  });
});
