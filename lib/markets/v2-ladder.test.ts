import { describe, it, expect } from 'vitest';
import { buildLadder, ladderSide } from './v2-ladder';
import { NO_FEES } from './v2-fees';
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

describe('ladderSide', () => {
  const RATES = { notional: 0.02, stake: 0.005 };
  const rung = () => buildLadder({ forward: 64_000, svi: SVI }, ADM)[0];

  it('mirrors the two directions: chance below is 1 − chance above', () => {
    const r = rung();
    expect(ladderSide(r, true, NO_FEES).chance).toBeCloseTo(r.chanceAbove, 12);
    expect(ladderSide(r, false, NO_FEES).chance).toBeCloseTo(1 - r.chanceAbove, 12);
  });

  it('agrees with the rung it came from on the up side', () => {
    // The rung has to be built with the SAME rates, since buildLadder bakes
    // netPayoutUp in at construction.
    const r = buildLadder({ forward: 64_000, svi: SVI }, ADM, undefined, RATES)[0];
    expect(ladderSide(r, true, NO_FEES).payout).toBeCloseTo(r.payoutUp, 12);
    expect(ladderSide(r, true, RATES).netPayout).toBeCloseTo(r.netPayoutUp, 12);
  });

  it('prices each side on its OWN chance, so the fee haircut differs by direction', () => {
    const r = rung(); // the top rung is a high chance-above, so DOWN is the longshot
    const up = ladderSide(r, true, RATES);
    const down = ladderSide(r, false, RATES);
    const haircut = (s: { payout: number; netPayout: number }) => 1 - s.netPayout / s.payout;
    expect(down.payout).toBeGreaterThan(up.payout);
    expect(haircut(down)).toBeGreaterThan(haircut(up));
  });

  it('charges nothing when no rates are given', () => {
    const r = rung();
    for (const isUp of [true, false]) {
      const s = ladderSide(r, isUp);
      expect(s.netPayout).toBeCloseTo(s.payout, 12);
    }
  });
});
