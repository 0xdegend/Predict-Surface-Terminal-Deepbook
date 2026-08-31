/**
 * legacy-history-data.ts — the carried-over trade history snapshots. SERVER ONLY.
 *
 * These files are large: 53 KB for 6-24 and 910 KB for 8-06, and they grow with every
 * release. The 6-24 seed was small enough to import straight into the history hook and
 * ship to the browser without anyone noticing. The 8-06 one is not: bundling both would
 * put nearly a megabyte of JSON into the client for a feature that, for any one visitor,
 * needs the handful of rows belonging to their own wallet.
 *
 * So the data lives here, behind /api/v2/legacy-history, and the browser asks for one
 * wallet's slice. Nothing imports this module from a client component. The pure merge
 * helpers a client DOES need are in legacy-history.ts, which holds no data at all.
 *
 * Which snapshots apply is decided by `carriedSnapshots`, never by a version flag, so a
 * seed can never be overlaid on the deployment it was captured from. See seed-registry.
 */
import seed624 from './legacy-history-6-24.json';
import seed806 from './legacy-history-8-06.json';
import { ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { carriedSnapshots } from '@/lib/leaderboard/seed-registry';
import type { PastPrediction } from './history';

interface HistorySeed {
  deployment: string;
  capturedAt: string;
  byOwner: Record<string, PastPrediction[]>;
}

/** Every snapshot we hold, oldest first. Add the next one here and nowhere else. */
const ALL_SEEDS: HistorySeed[] = [seed624 as unknown as HistorySeed, seed806 as unknown as HistorySeed];

/** The ones that apply while running on this deployment (never its own). */
const CARRIED: HistorySeed[] = carriedSnapshots(ALL_SEEDS, ACTIVE_V2_DEPLOYMENT);

/** Which releases are being carried, for a "history from …" note. */
export const LEGACY_HISTORY_SOURCE: string = CARRIED.map((s) => s.deployment).join(' + ');

/**
 * owner (lowercased) → every carried row for that wallet, across all applicable snapshots.
 *
 * Deduped by `key`. Rows are self-contained (strike and PnL already resolved at capture
 * time) so they need no market object from a dead deployment, and a wallet that traded on
 * both 6-24 and 8-06 gets one continuous history rather than the newer half.
 */
const BY_OWNER: Record<string, PastPrediction[]> = (() => {
  const merged: Record<string, PastPrediction[]> = {};
  for (const seed of CARRIED) {
    for (const [owner, rows] of Object.entries(seed.byOwner)) {
      const key = owner.toLowerCase();
      const prior = merged[key];
      if (!prior) {
        merged[key] = [...rows];
        continue;
      }
      const seen = new Set(prior.map((r) => r.key));
      for (const row of rows) if (!seen.has(row.key)) prior.push(row);
    }
  }
  for (const rows of Object.values(merged)) rows.sort((a, b) => b.settledAt - a.settledAt);
  return merged;
})();

/** A wallet's carried-over trades (empty for an unknown wallet, or when nothing applies). */
export function legacyHistoryFor(owner: string | undefined): PastPrediction[] {
  if (!owner) return [];
  return BY_OWNER[owner.toLowerCase()] ?? [];
}

/**
 * The carried-over history keyed by wallet — the resolved (won/lost) track record of every
 * returning Skew trader. Powers the admin's win-rate and join-over-time stats.
 */
export function legacyHistoryByOwner(): Record<string, PastPrediction[]> {
  return BY_OWNER;
}

/** All carried-over history rows, flattened (one entry per resolved position). */
export function allLegacyHistory(): PastPrediction[] {
  return Object.values(BY_OWNER).flat();
}
