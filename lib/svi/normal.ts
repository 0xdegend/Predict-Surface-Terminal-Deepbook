/**
 * lib/svi/normal.ts — standard normal CDF for the client-side surface math.
 *
 * The CONTRACT prices with Cody's fixed-point rational approximation
 * (oracle.move / math.move). We never use this for the trade price — that always
 * comes from the chain (lib/sui/quote.ts). This is for the surface, IV, and the
 * no-arb checker only, so a high-accuracy float approximation is correct and
 * simpler. A&S 7.1.26 via erf gives abs error ~1.5e-7 — far below any tolerance
 * that matters at the surface, and tighter than the contract's own truncation.
 */

/** erf(x) via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
