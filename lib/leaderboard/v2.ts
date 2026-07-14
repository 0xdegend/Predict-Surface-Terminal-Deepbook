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
  /** DUSDC staked specifically through the Skew app (builder-code attributed). */
  skewVolume?: number;
  /** Trades placed through the Skew app. */
  skewTrades?: number;
  /** True when any of this trader's bets carried the app's builder code. */
  viaSkew?: boolean;
  /** Newest mint/redeem timestamp (ms). */
  lastActiveMs?: number;
}

export function sortV2Rows(rows: V2LeaderboardRow[], key: V2SortKey): V2LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    if (key === 'volume') return b.volume - a.volume || b.points - a.points;
    return b.points - a.points || b.volume - a.volume;
  });
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
