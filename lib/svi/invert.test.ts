import { describe, it, expect } from 'vitest';
import { strikeForUpFair, strikeForDirectionFair, directionFair, payoutMultiple } from './invert';
import { upFair, type SviFloat } from './svi';
import { toFloat, FLOAT_SCALING } from '@/config/scale';
import type { Oracle } from '@/lib/api/types';

const E9 = FLOAT_SCALING;
const FORWARD = 60_000;
const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };

function oracle(): Oracle {
  return {
    predict_id: '0xp', oracle_id: '0xA', oracle_cap_id: '', underlying_asset: 'BTC',
    expiry: 0, min_strike: 50_000 * E9, tick_size: 1 * E9, status: 'active',
    activated_at: 0, settlement_price: null, settled_at: null, created_checkpoint: 0,
  };
}

describe('strikeForUpFair', () => {
  it('returns ~ATM (forward) for a 50% target', () => {
    const s = toFloat(Number(strikeForUpFair(0.5, FORWARD, SVI, oracle())));
    expect(s).toBeGreaterThan(FORWARD - 200);
    expect(s).toBeLessThan(FORWARD + 200);
  });

  it('round-trips: the strike it returns prices back near the target', () => {
    for (const target of [0.2, 0.4, 0.6, 0.8]) {
      const strike = toFloat(Number(strikeForUpFair(target, FORWARD, SVI, oracle())));
      expect(upFair(strike, FORWARD, SVI, null)).toBeCloseTo(target, 1);
    }
  });

  it('is monotone: a lower UP target gives a higher strike', () => {
    const sHi = Number(strikeForUpFair(0.2, FORWARD, SVI, oracle())); // unlikely UP → high strike
    const sLo = Number(strikeForUpFair(0.8, FORWARD, SVI, oracle())); // likely UP → low strike
    expect(sHi).toBeGreaterThan(sLo);
  });

  it('snaps to the $1 grid', () => {
    const scaled = strikeForUpFair(0.35, FORWARD, SVI, oracle());
    expect(scaled % BigInt(E9)).toBe(0n); // exact $1 tick
  });
});

describe('strikeForDirectionFair', () => {
  it('a DOWN target maps through 1−target', () => {
    // DOWN 70% likely ⇒ UP 30% ⇒ same strike as strikeForUpFair(0.3)
    const down = strikeForDirectionFair(0.7, FORWARD, SVI, oracle(), false);
    const up = strikeForUpFair(0.3, FORWARD, SVI, oracle());
    expect(down).toBe(up);
  });
});

describe('directionFair + payoutMultiple', () => {
  it('directionFair flips for DOWN', () => {
    const up = directionFair(FORWARD, FORWARD, SVI, true);
    const dn = directionFair(FORWARD, FORWARD, SVI, false);
    expect(up + dn).toBeCloseTo(1);
  });

  it('payout is 1/price, clamped', () => {
    expect(payoutMultiple(0.5)).toBeCloseTo(2);
    expect(payoutMultiple(0)).toBeCloseTo(100); // clamped at 0.01
  });
});
