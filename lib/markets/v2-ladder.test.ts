import { describe, it, expect } from 'vitest';
import { buildLadder } from './v2-ladder';
import { upFair, type SviFloat } from '@/lib/svi/svi';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 65_000;
const ADM = '1000000000'; // $1 admission grid (1e9-scaled)

describe('buildLadder', () => {
  const rungs = buildLadder({ forward: FORWARD, svi: SVI }, ADM);

  it('returns mintable rungs sorted by strike ascending', () => {
    expect(rungs.length).toBeGreaterThan(3);
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i].strike).toBeGreaterThan(rungs[i - 1].strike);
    }
    rungs.forEach((r) => expect(r.strike).toBeGreaterThan(0));
  });

  it('runs chance-above high → low as strike rises (monotone)', () => {
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i].chanceAbove).toBeLessThan(rungs[i - 1].chanceAbove);
    }
  });

  it('reports the surface chance-above at the snapped strike (matches upFair)', () => {
    rungs.forEach((r) => {
      expect(r.chanceAbove).toBeCloseTo(upFair(r.strike, FORWARD, SVI), 10);
      expect(r.chanceAbove).toBeGreaterThan(0);
      expect(r.chanceAbove).toBeLessThan(1);
    });
  });

  it('pays more for lower-chance (longshot) rungs', () => {
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i].payoutUp).toBeGreaterThan(rungs[i - 1].payoutUp);
    }
    rungs.forEach((r) => expect(r.payoutUp).toBeGreaterThan(1));
  });

  it('flags exactly one ATM rung, nearest the forward', () => {
    const atm = rungs.filter((r) => r.isAtm);
    expect(atm).toHaveLength(1);
    const nearest = rungs.reduce((a, b) => (Math.abs(a.strike - FORWARD) <= Math.abs(b.strike - FORWARD) ? a : b));
    expect(atm[0].strike).toBe(nearest.strike);
  });

  it('degrades to empty on an unpriceable forward', () => {
    expect(buildLadder({ forward: 0, svi: SVI }, ADM)).toEqual([]);
  });
});
