/**
 * lib/svi/svi.ts — pure SVI fair-price + implied-vol math.
 *
 * Mirrors oracle.move::compute_nd2 EXACTLY in formula (§6.2):
 *   k      = ln(strike / forward)                                  log-moneyness
 *   w(k)   = a + b * ( rho*(k - m) + sqrt((k - m)^2 + sigma^2) )   SVI total variance
 *   d2     = -( (k + w/2) / sqrt(w) )
 *   UP     = N(d2)
 *   DN     = 1 - UP
 *   range(lo,hi) = UP(lo) - UP(hi)                                 (>= 0 for lo < hi)
 * Settled oracle: UP = 1 if settlement > strike else 0.
 *
 * Inputs here are FLOATS (already de-scaled from 1e9). Convert raw oracle/SVI
 * events with `parseSvi` / config/scale first. This module is the visualization +
 * no-arb spine ONLY — never the trade price (§6.1). Pure + deterministic + tested.
 */
import { normalCdf } from './normal';
import { signedToFloat, toFloat } from '@/config/scale';
import type { SviEvent } from '@/lib/api/types';

export const MS_PER_YEAR = 31_536_000_000; // matches constants::ms_per_year

/** SVI params as floats (de-scaled from 1e9). rho/m may be negative. */
export interface SviFloat {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

/** Decode a raw SviEvent (1e9 magnitudes + sign flags) into float params. */
export function parseSvi(e: SviEvent): SviFloat {
  return {
    a: toFloat(e.a),
    b: toFloat(e.b),
    rho: signedToFloat(e.rho, e.rho_negative),
    m: signedToFloat(e.m, e.m_negative),
    sigma: toFloat(e.sigma),
  };
}

/** Log-moneyness k = ln(strike / forward). */
export function logMoneyness(strike: number, forward: number): number {
  return Math.log(strike / forward);
}

/** SVI total variance w(k) at a given log-moneyness. */
export function totalVarianceAtK(k: number, svi: SviFloat): number {
  const km = k - svi.m;
  const inner = svi.rho * km + Math.sqrt(km * km + svi.sigma * svi.sigma);
  return svi.a + svi.b * inner;
}

/** SVI total variance for a strike given the forward. */
export function totalVariance(strike: number, forward: number, svi: SviFloat): number {
  return totalVarianceAtK(logMoneyness(strike, forward), svi);
}

/**
 * Fair UP price (probability settlement > strike), live oracle.
 * For a settled oracle pass `settlement` to get the exact 1/0 payoff.
 */
export function upFair(
  strike: number,
  forward: number,
  svi: SviFloat,
  settlement?: number | null,
): number {
  if (settlement != null) return settlement > strike ? 1 : 0;
  const k = logMoneyness(strike, forward);
  const w = totalVarianceAtK(k, svi);
  if (w <= 0) return k < 0 ? 1 : 0; // degenerate; outside tradeable range
  const d2 = -((k + w / 2) / Math.sqrt(w));
  return normalCdf(d2);
}

/** Fair DN price = 1 - UP. */
export function dnFair(
  strike: number,
  forward: number,
  svi: SviFloat,
  settlement?: number | null,
): number {
  return 1 - upFair(strike, forward, svi, settlement);
}

/** Fair vertical-range price = UP(lower) - UP(higher). >= 0 for lower < higher. */
export function rangeFair(
  lower: number,
  higher: number,
  forward: number,
  svi: SviFloat,
  settlement?: number | null,
): number {
  return upFair(lower, forward, svi, settlement) - upFair(higher, forward, svi, settlement);
}

/**
 * Implied volatility σ_IV(k) = sqrt(w(k) / T), T in years.
 * This is the Z-axis of the surface — what traders actually read.
 */
export function impliedVol(strike: number, forward: number, svi: SviFloat, tYears: number): number {
  if (tYears <= 0) return 0;
  const w = totalVariance(strike, forward, svi);
  return w > 0 ? Math.sqrt(w / tYears) : 0;
}

/** Time to expiry in years from an expiry timestamp (ms). */
export function timeToExpiryYears(expiryMs: number, nowMs: number = Date.now()): number {
  return (expiryMs - nowMs) / MS_PER_YEAR;
}
