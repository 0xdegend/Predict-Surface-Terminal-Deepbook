/**
 * lib/insights/expected-move.ts — the surface's own expected move to an expiry.
 *
 * The 1σ move the SVI smile is pricing: `sigma = sqrt(w)`, where `w` is the ATM
 * total variance to that expiry (already tenor-scaled — the same `sqrt(totalVariance)`
 * the co-pilot's vol pill uses, so the band and the pill can't disagree). At ±1σ
 * the asset lands inside the band roughly 2 times in 3.
 *
 * This drives the Options page's "expected range by [expiry]" band and bounds the
 * probability ladder. PURE + SERVER-SAFE, unit-tested.
 */
import { totalVariance, type SviFloat } from '@/lib/svi/svi';

export interface ExpectedMove {
  /** The reference price the band is centered on (the market's forward). */
  forward: number;
  /** 1σ move as a fraction of price (e.g. 0.0085 = ±0.85%). */
  sigma: number;
  /** Lower / upper price at ±1σ. */
  lowPrice: number;
  highPrice: number;
}

/**
 * The ±1σ expected move for a market's smile. Returns null when the pricer can't
 * yield a finite, positive sigma (e.g. before the surface has loaded), so callers
 * hide the band rather than draw a degenerate one.
 */
export function expectedMove(pricer: { forward: number; svi: SviFloat }): ExpectedMove | null {
  const { forward, svi } = pricer;
  if (!(forward > 0)) return null;
  const sigma = Math.sqrt(Math.max(0, totalVariance(forward, forward, svi)));
  if (!(sigma > 0) || !Number.isFinite(sigma)) return null;
  return {
    forward,
    sigma,
    lowPrice: forward * (1 - sigma),
    highPrice: forward * (1 + sigma),
  };
}
