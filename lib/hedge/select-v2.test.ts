import { describe, it, expect } from 'vitest';
import { parseSvi, dnFair } from '@/lib/svi/svi';
import { selectDownHedgeV2 } from './select-v2';
import { toFloat } from '@/config/scale';
import type { SviEvent } from '@/lib/api/types';

// A realistic-ish short-dated BTC smile (same shape used in the legacy test).
const RAW_SVI = {
  a: 61536, b: 1309541, rho: 940001720, rho_negative: true, m: 4991572, m_negative: true, sigma: 1072703,
} as unknown as SviEvent;
const FORWARD = 66935.67;
const ADMISSION = 1_000_000_000n; // $1 admission grid (testnet cadence)

const svi = parseSvi(RAW_SVI);

describe('selectDownHedgeV2', () => {
  it('picks a downside strike strictly below forward, on the admission grid', () => {
    const pick = selectDownHedgeV2({ forward: FORWARD, svi, admissionTickSize: ADMISSION })!;
    expect(pick).not.toBeNull();
    expect(pick.strike).toBeLessThan(FORWARD);
    expect(pick.otmPct).toBeGreaterThan(0);
    // on grid: an exact multiple of the admission tick ($1 → integer dollars)
    expect(pick.strikeScaled % ADMISSION).toBe(0n);
    expect(Number.isInteger(toFloat(Number(pick.strikeScaled)))).toBe(true);
  });

  it('the chosen strike prices near the minFair floor (cheapest quotable)', () => {
    const minFair = 0.05;
    const pick = selectDownHedgeV2({ forward: FORWARD, svi, admissionTickSize: ADMISSION }, { minFair })!;
    const fair = dnFair(pick.strike, FORWARD, svi);
    expect(fair).toBeGreaterThanOrEqual(minFair - 0.02);
    expect(fair).toBeLessThan(0.5);
  });

  it('a deeper minFair floor still returns a valid OTM strike', () => {
    const pick = selectDownHedgeV2({ forward: FORWARD, svi, admissionTickSize: ADMISSION }, { minFair: 0.001, maxScanPct: 0.1 });
    expect(pick).not.toBeNull();
    expect(pick!.strike).toBeLessThan(FORWARD);
  });

  it('returns null on a degenerate (non-positive) forward', () => {
    expect(selectDownHedgeV2({ forward: 0, svi, admissionTickSize: ADMISSION })).toBeNull();
  });
});
