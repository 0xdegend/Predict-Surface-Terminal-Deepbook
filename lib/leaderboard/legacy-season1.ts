/**
 * legacy-season1.ts — the frozen Season 1 (6-24) board, for the archive view only.
 *
 * Split out from legacy-carryover deliberately, for two reasons.
 *
 * MEANING: the archive renders the final standings of the FIRST release. It is a historical
 * record of one season, not "everything carried forward", so it must stay pinned to the 6-24
 * snapshot. Pointing it at the carryover registry would silently repopulate the Season 1
 * page with 483 rows of 8-06 traders who were never in Season 1.
 *
 * WEIGHT: the archive is the only CLIENT consumer of any points snapshot. Keeping it on its
 * own module means the later, much larger snapshots stay server-side with the merge logic
 * that actually needs them, instead of being pulled into the browser bundle by a shared
 * import that only wanted fifteen rows.
 */
import seed624 from './legacy-points-6-24.json';
import type { LegacyRow } from './seed-registry';
export type { LegacyRow };

interface Season1Seed {
  deployment: string;
  capturedAt: string;
  rows: LegacyRow[];
}

const SEASON_1 = seed624 as unknown as Season1Seed;

/** The frozen Season 1 rows + when they were captured, so the archive renders straight from
 *  the stored snapshot with no backend. */
export const SEASON_1_ROWS: LegacyRow[] = SEASON_1.rows;
export const SEASON_1_CAPTURED_AT: string = SEASON_1.capturedAt;
export const SEASON_1_SOURCE: string = SEASON_1.deployment;
