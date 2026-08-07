/**
 * lib/leaderboard/legacy-carryover.ts — carry the 6-24 Skew leaderboard forward.
 *
 * The Skew points board is recomputed per deployment from that deployment's on-chain
 * trades, so a redeploy (6-24 → 8-06, see predict-refresh-8-06) resets it to empty. To
 * preserve standing we captured a one-time snapshot of the final 6-24 Skew board
 * (legacy-points-6-24.json) and overlay it as a baseline on the live board: a returning
 * wallet keeps its 6-24 points and KEEPS ACCUMULATING as it trades on the new deployment.
 *
 * Applied server-side in /api/v2/leaderboard for the 8-06 (V2_IS_729_PLUS) Skew board.
 * Points / volume / trades / PnL are additive (a career total); `legacyPoints` records
 * the carried amount so the UI can attribute it. Matching is by wallet address (stable
 * across deployments via the same zkLogin wallet), case-insensitive.
 *
 * There is no double-count risk: the seed is the 6-24 board, and 6-24 is never a
 * V2_IS_729_PLUS deployment, so this overlay never runs against 6-24's own board.
 */
import seedJson from './legacy-points-6-24.json';
import type { V2LeaderboardRow } from './v2';
import { sortV2Rows } from './v2';

interface LegacyRow {
  owner: string;
  points: number;
  volume: number;
  trades: number;
  netPnl?: number;
}
interface LegacySeed {
  deployment: string;
  capturedAt: string;
  rows: LegacyRow[];
}

const SEED = seedJson as unknown as LegacySeed;

/** owner (lowercased) → carried-over totals from 6-24. */
const LEGACY: Map<string, LegacyRow> = new Map(SEED.rows.map((r) => [r.owner.toLowerCase(), r]));

/** Header stats for a "carried over from 6-24" note. */
export const LEGACY_SOURCE = SEED.deployment;
export const LEGACY_TRADER_COUNT = SEED.rows.length;
export const LEGACY_TOTAL_POINTS = SEED.rows.reduce((s, r) => s + r.points, 0);

/**
 * Overlay the legacy 6-24 points onto a live board. Returns a NEW sorted array; never
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
