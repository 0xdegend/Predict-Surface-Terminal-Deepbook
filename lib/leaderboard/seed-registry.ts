/**
 * seed-registry.ts — which redeploy snapshots get overlaid on the deployment we are running.
 *
 * Every Predict republish recomputes the board from that deployment's own on-chain trades,
 * so a returning trader's standing resets to zero. We fix that by capturing the final board
 * of each retiring deployment and overlaying the snapshots additively, so points, volume,
 * trades and PnL are a career total rather than a per-release one.
 *
 * With one snapshot that was safe by accident. The rule was written as prose — "6-24 is
 * never a V2_IS_729_PLUS deployment, so this overlay never runs against 6-24's own board" —
 * and it held only because there was exactly one seed and it belonged to the one deployment
 * that could not load it. With TWO snapshots that reasoning collapses: 8-06 IS a
 * V2_IS_729_PLUS deployment, so the same prose would have loaded the 8-06 seed while running
 * ON 8-06 and doubled every trader's points, volume and trade count against their own live
 * trades. Nothing would have errored; the board would simply have been wrong by exactly 2x
 * for anyone who had traded, and correct for anyone who had not.
 *
 * So the rule is now code, in one place, with one test: a seed is overlaid only when it
 * belongs to a DIFFERENT deployment than the one we are reading live.
 */

/** Anything captured from a specific deployment. Both the points and the history seeds
 *  carry this, and both need the same guard, so the guard is generic over it. */
export interface DeploymentSnapshot {
  /** The deployment this snapshot was captured FROM, e.g. '6-24'. */
  deployment: string;
  capturedAt: string;
}

/**
 * One wallet's totals in a points snapshot.
 *
 * Declared HERE, in the module that holds no data, rather than alongside the seeds. The
 * Season 1 archive is a client component and needs this type but must never pull the
 * carryover module's JSON imports with it. A type-only import is erased today, but the
 * declaration living in a data-free module means the edge cannot come back if someone
 * later drops the `type` keyword.
 */
export interface LegacyRow {
  owner: string;
  points: number;
  volume: number;
  trades: number;
  netPnl?: number;
}

/**
 * The snapshots to overlay while running on `active`.
 *
 * Excludes any seed captured from `active` itself: those trades are already coming back
 * from the live read, and adding them again would double them. Order is preserved, and
 * overlaying several is additive, so a trader who traded on 6-24 and again on 8-06 carries
 * both into 8-21.
 */
export function carriedSnapshots<T extends DeploymentSnapshot>(all: readonly T[], active: string): T[] {
  return all.filter((s) => s.deployment !== active);
}
