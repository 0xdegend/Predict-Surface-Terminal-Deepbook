/**
 * lib/hedge/select.ts — pick the crash-insurance leg for the Hedge Vault.
 *
 * The hedge is a DOWN binary BELOW the forward: it pays $1·qty if settlement
 * lands under the strike — i.e. exactly when a sharp drop would hurt the vault
 * (PLP) we're also long. We want the CHEAPEST still-quotable such strike: the
 * most out-of-the-money grid strike whose fair price is at/above a small floor.
 *
 * NB these oracles are ultra-short (~15 min), so total variance is tiny and the
 * fair price collapses fast below the forward — a few % OTM is already near-zero
 * and unquotable (the contract aborts on a 0%/100% fair). So the realistic hedge
 * sits only ~0.5–2% OTM. We find the boundary by bisection on the fair curve
 * (monotonic in strike) then snap to a real tradeable tick. The chain quote
 * (lib/sui/quote) remains authoritative for the actual cost.
 */
import { dnFair } from '@/lib/svi/svi';
import { gridBounds, snapStrikeToTick } from '@/lib/keys';
import { fromFloat, toFloat } from '@/config/scale';
import type { SmileInput } from '@/lib/svi/surface';

export interface HedgePick {
  oracleId: string;
  expiry: number;
  strikeScaled: bigint; // 1e9-scaled, on grid
  strike: number; // float
  isUp: false; // downside crash binary
  fair: number; // client dnFair estimate at the snapped strike (display only)
  otmPct: number; // (forward - strike) / forward, >= 0
}

export interface HedgeSelectOpts {
  /** Cheapest insurance: the lowest fair we'll still place the hedge at. */
  minFair?: number;
  /** Don't search deeper than this fraction below forward. */
  maxScanPct?: number;
}

/**
 * Choose the most-OTM downside hedge strike that still prices at >= `minFair`.
 * Returns null if the smile is degenerate or no quotable down strike exists.
 */
export function selectDownHedge(input: SmileInput, opts: HedgeSelectOpts = {}): HedgePick | null {
  const minFair = opts.minFair ?? 0.04;
  const maxScanPct = opts.maxScanPct ?? 0.15;
  const { oracle, svi, forward } = input;
  if (!(forward > 0)) return null;

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

  // Snap to a real tradeable tick, and ensure we end up strictly below forward.
  const { minStrike, tickSize } = gridBounds(oracle);
  let strikeScaled = snapStrikeToTick(fromFloat(target), oracle);
  const fwdScaled = fromFloat(forward);
  if (strikeScaled >= fwdScaled) strikeScaled -= tickSize; // never hedge at/above forward
  if (strikeScaled < minStrike) strikeScaled = minStrike;

  const strike = toFloat(Number(strikeScaled));
  return {
    oracleId: oracle.oracle_id,
    expiry: oracle.expiry,
    strikeScaled,
    strike,
    isUp: false,
    fair: fairAt(strike),
    otmPct: Math.max(0, (forward - strike) / forward),
  };
}
