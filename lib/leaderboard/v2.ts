/**
 * lib/leaderboard/v2.ts — Season-2 standings row shape + sort/totals helpers for
 * the NEW deployment.
 *
 * The beta indexer has no per-owner aggregation endpoint, so the real board is
 * reconstructed by fanning the per-market order feeds out across the active/recent
 * markets and folding them into these rows — see lib/leaderboard/v2-aggregate and
 * useV2Leaderboard. Points use the SAME formula as the Portfolio (lib/points/score)
 * so the two agree.
 */

import { POINTS_RATES } from '@/lib/points/score';

export type V2SortKey = 'points' | 'volume';

/** One trader's standing — flat shape produced by the aggregator. */
export interface V2LeaderboardRow {
  owner: string;
  /** Points total (liquidity + performance + holding) from the shared formula. */
  points: number;
  /** DUSDC premium staked over the indexed window. */
  volume: number;
  trades: number;
  /** Net realized PnL over closed positions (DUSDC, signed). */
  netPnl?: number;
  /** Resolved-close outcomes over the in-scope closed positions (win = paid out more than
   *  its cost basis). Drives the admin's live win rate. Absent on legacy/carryover rows. */
  wins?: number;
  losses?: number;
  /** DUSDC staked specifically through the Skew app (builder-code attributed). */
  skewVolume?: number;
  /** Trades placed through the Skew app. */
  skewTrades?: number;
  /** True when any of this trader's bets carried the app's builder code. */
  viaSkew?: boolean;
  /** True when this wallet onboarded through the Skew starter-grant faucet. Set on
   *  both faucet-only rows (0 trades) and traders who also claimed. The UI badges the
   *  0-trade ones as "Starter" — see mergeFaucetParticipants + leaderboard-panel. */
  viaFaucet?: boolean;
  /** Newest mint/redeem timestamp (ms). */
  lastActiveMs?: number;
  /** Points carried over from an earlier deployment's Skew board (6-24 → 8-06), folded
   *  into `points`. Present only for traders with a carry-over. See legacy-carryover. */
  legacyPoints?: number;
}

export function sortV2Rows(rows: V2LeaderboardRow[], key: V2SortKey): V2LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    if (key === 'volume') return b.volume - a.volume || b.points - a.points;
    return b.points - a.points || b.volume - a.volume;
  });
}

/**
 * One trader's live position on the points board plus the point split that drives
 * it — the data behind the co-pilot's "how am I doing / what should I improve"
 * answers. The split is back-computed from the shared formula (see lib/points/score)
 * so it always sums to `points` and never disagrees with the Ranks tab.
 */
export interface LeaderboardStanding {
  /** 1-based rank on the points-sorted board. Null when this wallet isn't on it yet. */
  rank: number | null;
  /** Number of traders on the board. */
  total: number;
  points: number;
  volume: number;
  /** Net realized PnL (signed DUSDC), when the board knows it. */
  netPnl?: number;
  trades: number;
  /** Points needed to pass the trader one rank up (null at #1 or when unranked). */
  gapToNext: number | null;
  /** Point split — liquidity + performance + holding = points. */
  liquidityPts: number;
  performancePts: number;
  holdingPts: number;
}

/**
 * Find a wallet's standing on the points-sorted board. Owner match is
 * case-insensitive (addresses arrive in mixed case from different feeds). Returns
 * null only when `owner` is falsy; a wallet that has never traded returns a row
 * with `rank: null` (so the caller can say "you're not on the board yet"). The
 * board is sorted by points here to match the Ranks tab's default view.
 */
export function standingFor(
  rows: V2LeaderboardRow[],
  owner: string | null | undefined,
): LeaderboardStanding | null {
  if (!owner) return null;
  const sorted = sortV2Rows(rows, 'points');
  const key = owner.toLowerCase();
  const idx = sorted.findIndex((r) => r.owner.toLowerCase() === key);
  if (idx === -1) {
    return {
      rank: null,
      total: sorted.length,
      points: 0,
      volume: 0,
      netPnl: undefined,
      trades: 0,
      gapToNext: null,
      liquidityPts: 0,
      performancePts: 0,
      holdingPts: 0,
    };
  }
  const row = sorted[idx];
  const liquidityPts = row.volume * POINTS_RATES.perDusdcVolume;
  const performancePts = Math.max(0, row.netPnl ?? 0) * POINTS_RATES.perDusdcProfit;
  // Everything left over is holding time — floored at 0 so a rounding wobble in the
  // back-computed split can never show a negative component.
  const holdingPts = Math.max(0, row.points - liquidityPts - performancePts);
  const gapToNext = idx > 0 ? Math.max(0, sorted[idx - 1].points - row.points) : null;
  return {
    rank: idx + 1,
    total: sorted.length,
    points: row.points,
    volume: row.volume,
    netPnl: row.netPnl,
    trades: row.trades,
    gapToNext,
    liquidityPts,
    performancePts,
    holdingPts,
  };
}

export function v2LeaderboardTotals(rows: V2LeaderboardRow[]): {
  traders: number;
  volume: number;
  trades: number;
} {
  return {
    traders: rows.length,
    volume: rows.reduce((s, r) => s + r.volume, 0),
    trades: rows.reduce((s, r) => s + r.trades, 0),
  };
}
