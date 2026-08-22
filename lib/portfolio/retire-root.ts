/**
 * retire-root.ts — the single rule for when a position row should disappear for good,
 * shared by all three redeem handlers (portfolio panel, trade-rail positions panel, and
 * the simple-mode redeem flow).
 *
 * TWO WAYS A ROW IS FINISHED:
 *
 *  1. The close LANDED and took the whole position. Ordinary success.
 *
 *  2. The close was REFUSED because there is nothing left to take. On this deployment
 *     that means the protocol keeper already auto-redeemed a settled winner, while our
 *     per-market event scan kept missing the closing redeem, so the fold kept netting the
 *     root back open (see [[keeper-redeem-read-gap]]). The row then reappears every poll
 *     offering a claim that can never succeed.
 *
 * Case 2 is the important one, and it is SAFE precisely because it is a refusal: the chain
 * evaluated the close and rejected it for insufficient quantity. That is stronger evidence
 * than any read we could do, and it satisfies the guard's "write only on a confirmed close"
 * invariant. Failures where the position is still there (odds moved, stale data, rejected
 * in the wallet) are not in `isPositionGoneMessage`, so they never retire anything.
 */
import { isPositionGoneMessage } from '@/lib/sui/v2/abort';
import { getClosedRootsGuard } from './closed-roots-guard';

export interface RedeemOutcome {
  /** Transaction digest, or null/undefined when the attempt failed. */
  digest: string | null | undefined;
  /** True when the attempt was for the position's ENTIRE remaining quantity. */
  fullClose: boolean;
  /** The failure message, read synchronously (React state is stale after an await). */
  lastError: string | null;
}

/** Should this row be retired permanently? Pure, so the rule is testable. */
export function shouldRetireRoot({ digest, fullClose, lastError }: RedeemOutcome): boolean {
  if (digest) return fullClose;
  return isPositionGoneMessage(lastError);
}

/**
 * Apply the rule and record it. Returns true when the row was retired, so the caller can
 * close its dialog and clear the error instead of leaving a dead claim on screen.
 */
export function retireRootIfDone(
  outcome: RedeemOutcome,
  root: string | null | undefined,
  scope: string | null | undefined,
): boolean {
  if (!shouldRetireRoot(outcome)) return false;
  if (root && scope) getClosedRootsGuard(scope).markClosed(root);
  return true;
}
