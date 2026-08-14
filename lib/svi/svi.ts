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
 * Invert UP for a strike: find the strike whose fair UP price ≈ `target`.
 * UP is monotone non-increasing in strike (UP→1 for deep-low strikes, UP→0 for
 * deep-high), so a bisection over a forward-anchored bracket converges cleanly.
 * `target` is clamped to a hair inside (0, 1). Used to build a probability-defined
 * band (see `defaultBand`); pure, no grid snapping — the caller snaps.
 */
export function strikeForUpProb(target: number, forward: number, svi: SviFloat): number {
  const t = Math.min(0.999, Math.max(0.001, target));
  // Bracket wide enough to straddle any plausible band: UP(lo) > t > UP(hi).
  let lo = forward * 0.5;
  let hi = forward * 2;
  // upFair decreases with strike, so lo (small strike) has the higher UP.
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (upFair(mid, forward, svi) > t) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * A neutral "50/50" range band centered on the distribution: the interquartile
 * band `[UP=0.75, UP=0.25]`, so `rangeFair(lower, higher) ≈ 0.75 − 0.25 = 0.5` by
 * construction. Skew-aware for free (it inverts the same `upFair` the curve draws),
 * so the band leans correctly under skew. Returns raw floats — snap to the
 * admission grid before use.
 */
export function defaultBand(forward: number, svi: SviFloat): { lower: number; higher: number } {
  return {
    lower: strikeForUpProb(0.75, forward, svi),
    higher: strikeForUpProb(0.25, forward, svi),
  };
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
