import { describe, it, expect } from 'vitest';
import { parseSvi } from '@/lib/svi/svi';
import { dnFair } from '@/lib/svi/svi';
import { selectDownHedge } from './select';
import { toFloat } from '@/config/scale';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle, SviEvent } from '@/lib/api/types';

// A realistic-ish short-dated BTC smile (same shape used in whatif.test.ts).
const RAW_SVI = {
  a: 61536, b: 1309541, rho: 940001720, rho_negative: true, m: 4991572, m_negative: true, sigma: 1072703,
} as unknown as SviEvent;
const FORWARD = 66935.67;

function oracle(): Oracle {
  return {
    predict_id: '0xp', oracle_id: '0xA', oracle_cap_id: '0xc', underlying_asset: 'BTC',
    expiry: Date.now() + 15 * 60_000, min_strike: 50_000 * 1e9, tick_size: 1e9,
    status: 'active', activated_at: Date.now(), settlement_price: null, settled_at: null, created_checkpoint: 0,
  };
}
const input: SmileInput = { oracle: oracle(), svi: parseSvi(RAW_SVI), forward: FORWARD, settlement: null };

describe('selectDownHedge', () => {
  it('picks a downside strike strictly below forward, on the $1 grid', () => {
    const pick = selectDownHedge(input)!;
    expect(pick).not.toBeNull();
    expect(pick.isUp).toBe(false);
    expect(pick.strike).toBeLessThan(FORWARD);
    expect(pick.otmPct).toBeGreaterThan(0);
    // on grid: integer dollars (tick = 1.0)
    expect(Number.isInteger(toFloat(Number(pick.strikeScaled)))).toBe(true);
  });

  it('the chosen strike prices near the minFair floor (cheapest quotable)', () => {
    const minFair = 0.05;
    const pick = selectDownHedge(input, { minFair })!;
    const fair = dnFair(pick.strike, FORWARD, input.svi);
    // at/above the floor, and not wildly expensive (it hugs the boundary)
    expect(fair).toBeGreaterThanOrEqual(minFair - 0.02);
    expect(fair).toBeLessThan(0.5);
  });

  it('a deeper minFair=0 floor still returns a valid OTM strike', () => {
    const pick = selectDownHedge(input, { minFair: 0.001, maxScanPct: 0.1 });
    expect(pick).not.toBeNull();
    expect(pick!.strike).toBeLessThan(FORWARD);
  });
});
