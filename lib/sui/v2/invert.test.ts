import { describe, it, expect } from 'vitest';
import { strikeForUpFair, strikeForDirectionFair, payoutMultiple } from './invert';
import { upFair, type SviFloat } from '@/lib/svi/svi';
import { toFloat, FLOAT_SCALING } from '@/config/scale';

const E9 = FLOAT_SCALING;
const FORWARD = 60_000;
const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const ADM = BigInt(E9); // $1 admission grid

describe('strikeForUpFair (v2 admission grid)', () => {
  it('returns ~ATM (forward) for a 50% target', () => {
    const s = toFloat(Number(strikeForUpFair(0.5, FORWARD, SVI, ADM)));
    expect(s).toBeGreaterThan(FORWARD - 200);
    expect(s).toBeLessThan(FORWARD + 200);
  });

  it('round-trips: the strike it returns prices back near the target', () => {
    for (const target of [0.2, 0.4, 0.6, 0.8]) {
      const strike = toFloat(Number(strikeForUpFair(target, FORWARD, SVI, ADM)));
      expect(upFair(strike, FORWARD, SVI, null)).toBeCloseTo(target, 1);
    }
  });

  it('is monotone: a lower UP target gives a higher strike', () => {
    const sHi = Number(strikeForUpFair(0.2, FORWARD, SVI, ADM)); // unlikely UP → high strike
    const sLo = Number(strikeForUpFair(0.8, FORWARD, SVI, ADM)); // likely UP → low strike
    expect(sHi).toBeGreaterThan(sLo);
  });

  it('snaps to the admission grid', () => {
    const scaled = strikeForUpFair(0.35, FORWARD, SVI, ADM);
    expect(scaled % ADM).toBe(0n);
  });
});

describe('strikeForDirectionFair (v2)', () => {
  it('a DOWN target maps through 1−target', () => {
    const down = strikeForDirectionFair(0.7, FORWARD, SVI, ADM, false);
    const up = strikeForUpFair(0.3, FORWARD, SVI, ADM);
    expect(down).toBe(up);
  });
});

describe('payoutMultiple (re-exported, shared with legacy)', () => {
  it('payout is 1/price, clamped', () => {
    expect(payoutMultiple(0.5)).toBeCloseTo(2);
    expect(payoutMultiple(0)).toBeCloseTo(100); // clamped at 0.01
  });
});
