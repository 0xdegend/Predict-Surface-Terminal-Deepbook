/**
 * lib/hedge/select-v2.ts — pick the crash-insurance leg for the v2 Liquidity
 * vault (the Latest-deployment mirror of lib/hedge/select.ts).
 *
 * The hedge is a DOWN binary BELOW the forward: it pays $1·qty if settlement
 * lands under the strike — i.e. exactly when a sharp drop would hurt the PLP
 * vault a liquidity provider is long. We want the CHEAPEST still-quotable such
 * strike: the most out-of-the-money admission-grid strike whose fair price is
 * at/above a small floor.
 *
 * Same shape and bisection as legacy's selector, but resolved against v2's
 * ADMISSION grid (snapStrikeToAdmission / admission_tick_size) instead of the
 * legacy Oracle grid, and priced off the live Pricer's SVI. v2 markets are
 * ultra-short (1m–1h), so total variance is tiny and the fair price collapses
 * fast below the forward — a few % OTM is already near-zero and unquotable (the
 * contract aborts on a 0%/100% fair). So the realistic hedge sits only ~0.5–2%
 * OTM; we find the boundary by bisection on the fair curve (monotone in strike)
 * then snap to a real admission tick. The budget mint (mint_exact_amount) stays
 * authoritative for the actual cost — this is strike selection + display only.
 */
import { dnFair, type SviFloat } from '@/lib/svi/svi';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { fromFloat, toFloat } from '@/config/scale';

export interface HedgePickV2 {
  strikeScaled: bigint; // 1e9-scaled, snapped to the admission grid
  strike: number; // float
  fair: number; // client dnFair estimate at the snapped strike (display only)
  otmPct: number; // (forward - strike) / forward, >= 0
}

export interface HedgeSelectV2Opts {
  /** Cheapest insurance: the lowest fair we'll still place the hedge at. */
  minFair?: number;
  /** Don't search deeper than this fraction below forward. */
  maxScanPct?: number;
}

/**
 * Choose the most-OTM downside hedge strike that still prices at >= `minFair`.
 * Returns null if the smile is degenerate or no quotable down strike exists.
 */
export function selectDownHedgeV2(
  input: { forward: number; svi: SviFloat; admissionTickSize: bigint },
  opts: HedgeSelectV2Opts = {},
): HedgePickV2 | null {
  const minFair = opts.minFair ?? 0.04;
  const maxScanPct = opts.maxScanPct ?? 0.15;
  const { forward, svi, admissionTickSize } = input;
  if (!(forward > 0) || admissionTickSize <= 0n) return null;

  const fairAt = (s: number) => dnFair(s, forward, svi);

  // dnFair is monotonically DECREASING as the strike drops (a lower strike is a
  // deeper crash bet → cheaper). hi=forward prices ~0.5; lo is the scan floor.
  const hi = forward;
  const lo = forward * (1 - maxScanPct);
  if (fairAt(hi) < minFair) return null; // even ATM too cheap → degenerate smile

  let target: number;
  if (fairAt(lo) >= minFair) {
    target = lo; // whole scan band is quotable → take the deepest (cheapest)
  } else {
    // bisection for the strike where dnFair crosses minFair (lowest still >= floor)
    let a = lo;
    let b = hi;
    for (let i = 0; i < 48; i++) {
      const mid = (a + b) / 2;
      if (fairAt(mid) >= minFair) b = mid;
      else a = mid;
    }
    target = b;
  }

  // Snap to a real admission tick, strictly below forward and above zero.
  let strikeScaled = snapStrikeToAdmission(fromFloat(target), admissionTickSize);
  const fwdScaled = fromFloat(forward);
  if (strikeScaled >= fwdScaled) strikeScaled -= admissionTickSize; // never hedge at/above forward
  if (strikeScaled < admissionTickSize) strikeScaled = admissionTickSize; // stay on grid, > 0

  const strike = toFloat(Number(strikeScaled));
  return {
    strikeScaled,
    strike,
    fair: fairAt(strike),
    otmPct: Math.max(0, (forward - strike) / forward),
  };
}
