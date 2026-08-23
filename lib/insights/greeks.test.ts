import { describe, it, expect } from 'vitest';
import { contractGreeks, repricer, scenarioCurve, settlesInMoney, defaultSpan, type ContractSpec } from './greeks';
import { upFair, dnFair, rangeFair, type SviFloat } from '@/lib/svi/svi';

// A normal BTC-ish smile.
const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 64_000;
const NOW = 1_000_000_000_000;
const EXPIRY = NOW + 2 * 3_600_000; // 2h out

const binUp = (strike: number): ContractSpec => ({ kind: 'binary', strike, isUp: true });
const binDn = (strike: number): ContractSpec => ({ kind: 'binary', strike, isUp: false });

describe('contractGreeks — fair matches the surface primitives', () => {
  it('binary fair equals upFair / dnFair', () => {
    const up = contractGreeks({ spec: binUp(65_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(up.fair).toBeCloseTo(upFair(65_000, FORWARD, SVI), 10);
    const dn = contractGreeks({ spec: binDn(65_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(dn.fair).toBeCloseTo(dnFair(65_000, FORWARD, SVI), 10);
  });

  it('range fair equals rangeFair', () => {
    const g = contractGreeks({ spec: { kind: 'range', lower: 63_000, higher: 65_000 }, forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(g.fair).toBeCloseTo(rangeFair(63_000, 65_000, FORWARD, SVI), 10);
  });
});

describe('contractGreeks — delta', () => {
  it('an UP bet gains as the forward rises (delta > 0), a DOWN bet loses (delta < 0)', () => {
    const up = contractGreeks({ spec: binUp(65_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    const dn = contractGreeks({ spec: binDn(65_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(up.delta).toBeGreaterThan(0);
    expect(dn.delta).toBeLessThan(0);
    // Mirror sides move exactly opposite.
    expect(up.delta).toBeCloseTo(-dn.delta, 12);
  });

  it('delta is steepest at the money', () => {
    const atm = contractGreeks({ spec: binUp(FORWARD), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    const otm = contractGreeks({ spec: binUp(70_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(Math.abs(atm.delta)).toBeGreaterThan(Math.abs(otm.delta));
  });

  it('matches a coarse manual difference of upFair', () => {
    const g = contractGreeks({ spec: binUp(64_500), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    const manual = (upFair(64_500, FORWARD + 20, SVI) - upFair(64_500, FORWARD - 20, SVI)) / 40;
    expect(g.delta).toBeCloseTo(manual, 6);
  });
});

describe('contractGreeks — vega (sensitivity to implied vol)', () => {
  it('an out-of-the-money bet GAINS on higher vol, one already in the money loses', () => {
    // More movement priced in = more chance of reaching a strike above, and more chance
    // of losing one you are already through.
    const otm = contractGreeks({ spec: binUp(70_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    const itm = contractGreeks({ spec: binUp(60_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(otm.vegaPerVolPoint).toBeGreaterThan(0);
    expect(itm.vegaPerVolPoint).toBeLessThan(0);
  });

  it('a band around the money LOSES on higher vol — more movement, less chance of pinning', () => {
    const around = contractGreeks({
      spec: { kind: 'range', lower: 62_000, higher: 66_000 },
      forward: FORWARD,
      svi: SVI,
      expiryMs: EXPIRY,
      now: NOW,
    });
    expect(around.vegaPerVolPoint).toBeLessThan(0);
  });

  it('is a per-POINT sensitivity, so it stays a small probability change', () => {
    const g = contractGreeks({ spec: binUp(66_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(Math.abs(g.vegaPerVolPoint)).toBeLessThan(0.25);
  });

  it('is zero once there is no time left (no vol to be sensitive to)', () => {
    const done = contractGreeks({ spec: binUp(65_000), forward: FORWARD, svi: SVI, expiryMs: NOW - 1, now: NOW });
    expect(done.vegaPerVolPoint).toBe(0);
  });
});

describe('contractGreeks — theta (time decay)', () => {
  it('an out-of-the-money binary bleeds toward $0 (theta < 0)', () => {
    const otmUp = contractGreeks({ spec: binUp(66_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(otmUp.fair).toBeLessThan(0.5);
    expect(otmUp.thetaPerHour).toBeLessThan(0);
  });

  it('a deep in-the-money binary is helped by time (theta > 0)', () => {
    // UP strike well below the forward: worth < 100% now, resolves to 100%.
    const itmUp = contractGreeks({ spec: binUp(60_000), forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(itmUp.fair).toBeGreaterThan(0.5);
    expect(itmUp.thetaPerHour).toBeGreaterThan(0);
  });

  it('a band around the forward gains as vol decays (theta > 0), one excluding it decays', () => {
    const around = contractGreeks({ spec: { kind: 'range', lower: 62_000, higher: 66_000 }, forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(around.thetaPerHour).toBeGreaterThan(0);
    const away = contractGreeks({ spec: { kind: 'range', lower: 68_000, higher: 70_000 }, forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW });
    expect(away.thetaPerHour).toBeLessThan(0);
  });

  it('is zero once expired, and never NaN', () => {
    const done = contractGreeks({ spec: binUp(65_000), forward: FORWARD, svi: SVI, expiryMs: NOW - 1, now: NOW });
    expect(done.thetaPerHour).toBe(0);
    expect(Number.isFinite(done.delta)).toBe(true);
    expect(Number.isFinite(done.fair)).toBe(true);
  });
});

describe('scenarioCurve', () => {
  const spec = binUp(65_000);
  const input = { spec, forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW };

  it('marks the current forward at the live fair', () => {
    const pts = scenarioCurve(input, { steps: 40 });
    const mid = pts.find((p) => Math.abs(p.move) < 1e-9);
    expect(mid).toBeTruthy();
    expect(mid!.mark).toBeCloseTo(upFair(65_000, FORWARD, SVI), 8);
  });

  it('mark-now is monotone increasing in forward for an UP bet', () => {
    const pts = scenarioCurve(input, { steps: 60 });
    for (let i = 1; i < pts.length; i++) expect(pts[i].mark).toBeGreaterThanOrEqual(pts[i - 1].mark - 1e-12);
  });

  it('the at-expiry step flips at the strike', () => {
    const pts = scenarioCurve(input, { steps: 200, spanPct: 0.05 });
    for (const p of pts) expect(p.expiry).toBe(p.forward > 65_000 ? 1 : 0);
  });

  it('spans the requested symmetric range with the right point count', () => {
    const pts = scenarioCurve(input, { steps: 50, spanPct: 0.03 });
    expect(pts.length).toBe(51);
    expect(pts[0].forward).toBeCloseTo(FORWARD * 0.97, 6);
    expect(pts[pts.length - 1].forward).toBeCloseTo(FORWARD * 1.03, 6);
    expect(pts[0].move).toBeCloseTo(-0.03, 9);
  });

  it('a range contract shows two at-expiry jumps (only the band pays)', () => {
    const rangePts = scenarioCurve(
      { spec: { kind: 'range', lower: 63_000, higher: 65_000 }, forward: FORWARD, svi: SVI, expiryMs: EXPIRY, now: NOW },
      { steps: 200, spanPct: 0.06 },
    );
    for (const p of rangePts) expect(p.expiry).toBe(p.forward > 63_000 && p.forward <= 65_000 ? 1 : 0);
  });
});

describe('repricer + helpers', () => {
  it('repricer reproduces the fair chance at the current forward', () => {
    const price = repricer({ spec: binUp(65_000), svi: SVI });
    expect(price(FORWARD)).toBeCloseTo(upFair(65_000, FORWARD, SVI), 10);
  });

  it('settlesInMoney reads the outcome for both kinds', () => {
    expect(settlesInMoney(binUp(65_000), 65_500)).toBe(true);
    expect(settlesInMoney(binUp(65_000), 64_500)).toBe(false);
    expect(settlesInMoney(binDn(65_000), 64_500)).toBe(true);
    expect(settlesInMoney({ kind: 'range', lower: 63_000, higher: 65_000 }, 64_000)).toBe(true);
    expect(settlesInMoney({ kind: 'range', lower: 63_000, higher: 65_000 }, 66_000)).toBe(false);
  });

  it('defaultSpan is a sane, clamped fraction', () => {
    const span = defaultSpan(SVI);
    expect(span).toBeGreaterThanOrEqual(0.004);
    expect(span).toBeLessThanOrEqual(0.2);
  });
});
