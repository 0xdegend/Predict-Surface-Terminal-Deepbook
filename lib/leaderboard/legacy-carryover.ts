/**
 * lib/leaderboard/legacy-carryover.ts — carry every retired Skew leaderboard forward.
 *
 * The Skew points board is recomputed per deployment from that deployment's own on-chain
 * trades, so each redeploy (6-24 → 8-06 → 8-21) resets a returning trader to zero. To
 * preserve standing we snapshot the final board of each retiring deployment and overlay
 * them as a baseline: a wallet keeps everything it earned and KEEPS ACCUMULATING as it
 * trades on the new release.
 *
 * Overlays CHAIN. Running on 8-21 carries both 6-24 and 8-06, added together, because the
 * 8-06 capture was scored from raw 8-06 on-chain events and does NOT itself include the
 * 6-24 carryover (that overlay is applied here, at read time, not baked into the seed).
 *
 * Applied server-side in /api/v2/leaderboard. Points / volume / trades / PnL are additive
 * (a career total); `legacyPoints` records the carried amount so the UI can attribute it.
 * Matching is by wallet address, which is stable across deployments via the same zkLogin
 * wallet, case-insensitive.
 *
 * Which seeds apply is decided by `carriedSnapshots`, NOT by a version flag — see
 * seed-registry.ts for why that distinction is what stops the board doubling.
 */
import seed624 from './legacy-points-6-24.json';
import seed806 from './legacy-points-8-06.json';
import { ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { carriedSnapshots, type LegacyRow } from './seed-registry';
import type { V2LeaderboardRow } from './v2';
import { sortV2Rows } from './v2';

export type { LegacyRow };

export interface LegacySeed {
  deployment: string;
  capturedAt: string;
  rows: LegacyRow[];
}

/** Every snapshot we hold, oldest first. Add the next one here and nowhere else. */
const ALL_SEEDS: LegacySeed[] = [seed624 as unknown as LegacySeed, seed806 as unknown as LegacySeed];

/** The ones that apply right now: every seed EXCEPT one captured from the deployment we are
 *  reading live, whose trades are already in the live board and would otherwise be doubled. */
const CARRIED: LegacySeed[] = carriedSnapshots(ALL_SEEDS, ACTIVE_V2_DEPLOYMENT);

/** owner (lowercased) → the sum of that wallet's totals across every carried snapshot. */
const LEGACY: Map<string, LegacyRow> = (() => {
  const merged = new Map<string, LegacyRow>();
  for (const seed of CARRIED) {
    for (const row of seed.rows) {
      const key = row.owner.toLowerCase();
      const prior = merged.get(key);
      if (!prior) {
        merged.set(key, { ...row });
        continue;
      }
      // Two releases, one trader: a career total, not the more recent of the two.
      prior.points += row.points;
      prior.volume += row.volume;
      prior.trades += row.trades;
      if (row.netPnl != null) prior.netPnl = (prior.netPnl ?? 0) + row.netPnl;
    }
  }
  return merged;
})();

/** Header stats for a "carried over" note: which releases, and how much they add up to. */
export const LEGACY_SOURCE = CARRIED.map((s) => s.deployment).join(' + ');
export const LEGACY_TRADER_COUNT = LEGACY.size;
export const LEGACY_TOTAL_POINTS = [...LEGACY.values()].reduce((sum, r) => sum + r.points, 0);
/** The snapshots in play, for a caller that needs to name or count them. */
export const LEGACY_SEEDS: readonly LegacySeed[] = CARRIED;

/** The carried-over wallets (owner addresses, lowercased). These are KNOWN app
 *  traders, so the leaderboard indexer fans out their full new-deployment history to
 *  keep them on the VENUE board too — not just the Skew board via the seed overlay —
 *  even before our builder code is registered (which is what normally identifies app
 *  users to rescue from a bot-dominated scan window). See lib/leaderboard/v2-indexer. */
export const LEGACY_OWNERS: string[] = [...LEGACY.keys()];

/**
 * Overlay the carried points onto a live board. Returns a NEW sorted array; never
 * mutates its input.
 *  - a live trader who also has legacy points gets them added, plus `legacyPoints`;
 *  - a legacy trader who hasn't traded on the new deployment yet is added as a row
 *    carrying only their legacy totals.
 * `legacy` is injectable for tests.
 */
export function mergeLegacyCarryover(
  live: V2LeaderboardRow[],
  legacy: Map<string, LegacyRow> = LEGACY,
): V2LeaderboardRow[] {
  if (legacy.size === 0) return live;

  const byOwner = new Map<string, V2LeaderboardRow>();
  for (const r of live) byOwner.set(r.owner.toLowerCase(), { ...r });

  for (const [key, L] of legacy) {
    const existing = byOwner.get(key);
    if (existing) {
      existing.points += L.points;
      existing.volume += L.volume;
      existing.trades += L.trades;
      if (L.netPnl != null) existing.netPnl = (existing.netPnl ?? 0) + L.netPnl;
      existing.legacyPoints = (existing.legacyPoints ?? 0) + L.points;
      existing.viaSkew = true;
    } else {
      byOwner.set(key, {
        owner: L.owner,
        points: L.points,
        volume: L.volume,
        trades: L.trades,
        netPnl: L.netPnl ?? 0,
        legacyPoints: L.points,
        viaSkew: true,
      });
    }
  }
  return sortV2Rows([...byOwner.values()], 'points');
}
