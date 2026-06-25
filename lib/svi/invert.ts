/**
 * lib/svi/invert.ts — invert the fair-price curve: given a target probability /
 * payout, find the grid strike that produces it. The payout slider drives this
 * (slide to an implied probability → the strike that prices there).
 *
 * `upFair(strike)` is monotone DECREASING in strike (a higher strike is less
 * likely to settle above), so a bisection converges cleanly. The result is
 * snapped to the oracle's tick grid, so it's always a mintable strike.
 */
import { upFair, type SviFloat } from './svi';
import { fromFloat } from '@/config/scale';
import { snapStrikeToTick } from '@/lib/keys';
import type { Oracle } from '@/lib/api/types';

/** Strike (1e9-scaled, snapped to grid) whose UP fair price ≈ `targetUp`. */
export function strikeForUpFair(
  targetUp: number,
  forward: number,
  svi: SviFloat,
  oracle: Oracle,
  settlement: number | null = null,
): bigint {
  const target = Math.min(0.999, Math.max(0.001, targetUp));
  // Bracket: deep ITM (≈1) … deep OTM (≈0) around the forward.
  let lo = forward * 0.5;
  let hi = forward * 1.5;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const f = upFair(mid, forward, svi, settlement);
    if (f > target) lo = mid; // still too likely → raise the strike
    else hi = mid;
  }
  return snapStrikeToTick(fromFloat((lo + hi) / 2), oracle);
}

/** The chosen direction's fair probability for a strike. */
export function directionFair(
  strikeFloat: number,
  forward: number,
  svi: SviFloat,
  isUp: boolean,
  settlement: number | null = null,
): number {
  const up = upFair(strikeFloat, forward, svi, settlement);
  return isUp ? up : 1 - up;
}

/** Strike for a target DIRECTION fair (handles UP vs DOWN). */
export function strikeForDirectionFair(
  targetDir: number,
  forward: number,
  svi: SviFloat,
  oracle: Oracle,
  isUp: boolean,
  settlement: number | null = null,
): bigint {
  const targetUp = isUp ? targetDir : 1 - targetDir;
  return strikeForUpFair(targetUp, forward, svi, oracle, settlement);
}

/** Payout multiple (what $1 returns) for a fair probability, clamped sanely. */
export function payoutMultiple(dirFair: number): number {
  return 1 / Math.min(0.99, Math.max(0.01, dirFair));
}
