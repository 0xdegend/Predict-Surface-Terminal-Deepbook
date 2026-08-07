/**
 * lib/portfolio/legacy-history.ts — carry each wallet's 6-24 trade history forward.
 *
 * Trade history is derived from the current deployment's order events keyed by the
 * wallet's (deployment-specific) account, so a redeploy (6-24 → 8-06, see
 * predict-refresh-8-06) leaves a returning trader with an EMPTY history tab. To keep it
 * continuous we captured each Skew wallet's fully-derived 6-24 rows (legacy-history-6-24
 * .json — self-contained PastPredictions, strikes/PnL already resolved, so they need no
 * 6-24 market object) and merge them under the connected wallet's live 8-06 history.
 *
 * Matched by wallet address (stable across deployments via the same zkLogin wallet),
 * case-insensitive. NEVER overlaid on its own source deployment (6-24), so live 6-24
 * rows are never doubled. Applied in useV2History, so it covers the portfolio tab, a
 * trader profile, and Kelly alike.
 */
import seedJson from './legacy-history-6-24.json';
import { ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import type { PastPrediction } from './history';

interface HistorySeed {
  deployment: string;
  capturedAt: string;
  byOwner: Record<string, PastPrediction[]>;
}

const SEED = seedJson as unknown as HistorySeed;

/** Off on the seed's own deployment (would double the live 6-24 rows). */
const CARRYOVER_ACTIVE = ACTIVE_V2_DEPLOYMENT !== SEED.deployment;

export const LEGACY_HISTORY_SOURCE = SEED.deployment;

/** A wallet's carried-over trades (empty when off, unknown wallet, or none). */
export function legacyHistoryFor(owner: string | undefined): PastPrediction[] {
  if (!CARRYOVER_ACTIVE || !owner) return [];
  return SEED.byOwner[owner.toLowerCase()] ?? [];
}

/** Pure merge: live rows + legacy rows, newest-first, deduped by `key` (live wins).
 *  Returns the input untouched when there's nothing to add. */
export function mergeHistoryRows(live: PastPrediction[], legacy: PastPrediction[]): PastPrediction[] {
  if (legacy.length === 0) return live;
  const seen = new Set(live.map((r) => r.key));
  return [...live, ...legacy.filter((r) => !seen.has(r.key))].sort((a, b) => b.settledAt - a.settledAt);
}

/** Merge a wallet's carried-over 6-24 history under its live history. */
export function mergeLegacyHistory(owner: string | undefined, live: PastPrediction[]): PastPrediction[] {
  return mergeHistoryRows(live, legacyHistoryFor(owner));
}
