/**
 * lib/insights/surface-shape — the two numbers a desk reads a surface's SHAPE with,
 * and the one that says what the market thinks money is worth over the tenor.
 *
 * The page could already draw the surface and price any strike on it, but it never put
 * a number on either of the questions a trader asks about shape:
 *
 *   • RISK REVERSAL — is downside or upside the expensive side right now?
 *   • BASIS — is the forward above or below spot, and by how much?
 *
 * DEFINING 25-DELTA WITHOUT DELTAS. A vanilla desk quotes the 25-delta risk reversal.
 * Our surface prices binaries, whose natural coordinate is the chance of finishing
 * above a strike, so the equivalent is taken at the 25% and 75% chance-above strikes:
 * the OTM call side and the OTM put side, symmetric in probability. RR = IV(call side)
 * − IV(put side), in vol points. Negative means puts are bid, the usual crypto stress
 * signature; positive means calls are.
 *
 * Pure + deterministic — no chain, no fetch, no React (CLAUDE.md §6.5).
 */
import { bisectUpFairStrike } from '@/lib/svi/invert';
import { impliedVol, timeToExpiryYears, type SviFloat } from '@/lib/svi/svi';

/** The probability-space stand-in for 25-delta: the strike with a 25% chance above. */
const CALL_SIDE_CHANCE = 0.25;
/** Its mirror — a 75% chance above is a 25% chance below. */
const PUT_SIDE_CHANCE = 0.75;

export interface SurfaceShape {
  /** IV at the OTM call-side strike (annualized fraction). */
  callIv: number;
  /** IV at the OTM put-side strike (annualized fraction). */
  putIv: number;
  /** callIv − putIv, in VOL POINTS. Negative = puts bid (downside is the dear side). */
  rr25Pts: number;
  /** The strikes the two IVs were read at ($). */
  callStrike: number;
  putStrike: number;
}

/**
 * The smile's 25-delta-equivalent risk reversal for one expiry. Null when the expiry
 * has no life left (there is no vol to read) or the pricer is degenerate.
 */
export function riskReversal(
  pricer: { forward: number; svi: SviFloat },
  expiryMs: number,
  now: number,
): SurfaceShape | null {
  const { forward, svi } = pricer;
  const tYears = timeToExpiryYears(expiryMs, now);
  if (!(forward > 0) || tYears <= 0) return null;

  const callStrike = bisectUpFairStrike(CALL_SIDE_CHANCE, forward, svi);
  const putStrike = bisectUpFairStrike(PUT_SIDE_CHANCE, forward, svi);
  const callIv = impliedVol(callStrike, forward, svi, tYears);
  const putIv = impliedVol(putStrike, forward, svi, tYears);
  if (!Number.isFinite(callIv) || !Number.isFinite(putIv)) return null;

  return { callIv, putIv, rr25Pts: (callIv - putIv) * 100, callStrike, putStrike };
}

/**
 * Forward premium over spot, in percent. What the market charges to hold the move to
 * this expiry rather than now: positive is contango (forward above spot), negative is
 * backwardation. Null without both numbers.
 */
export function forwardBasisPct(forward: number, spot: number | null | undefined): number | null {
  if (!(forward > 0) || !spot || !(spot > 0)) return null;
  return ((forward - spot) / spot) * 100;
}
