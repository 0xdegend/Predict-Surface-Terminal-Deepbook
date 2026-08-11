/**
 * lib/leaderboard/user-stats.ts — Skew user + performance statistics for the admin.
 *
 * Two honest sources, combined:
 *   - the Skew leaderboard rows (live 8-06 + Season-1 carryover + faucet): who the users
 *     are, their volume / trades / net PnL / points, who's active, AND the per-owner
 *     resolved-close win/loss tallies (v2-aggregate now folds them), so the win rate and
 *     realized PnL are LIVE off the board, not frozen;
 *   - the carryover trade history (won/lost per position): a continuity base for the win
 *     rate and the join curve, so Season-1 results don't vanish on the redeploy.
 *
 * Everything is LIVE: it grows as users trade on the current deployment. The board already
 * carries the Season-1 carryover (points + netPnl via mergeLegacyCarryover), so realized
 * PnL reads straight off the board; win/loss counts add the carryover history on top
 * (different deployment → no overlap). Pure + deterministic (pass `nowMs`) → unit-tested.
 */
import type { V2LeaderboardRow } from './v2';
import type { PastPrediction } from '@/lib/portfolio/history';

const DAY_MS = 86_400_000;

/** A point on the cumulative-users curve (structurally a chart ChartPoint). */
export interface UserJoinPoint {
  x: number;
  y: number;
  label: string;
}

export interface TopTrader {
  owner: string;
  netPnl: number;
  trades: number;
  volume: number;
  points: number;
}

export interface SkewUserStats {
  /** Everyone on the Skew board — traders + faucet onboards. */
  totalUsers: number;
  /** Wallets that have placed at least one bet. */
  tradingUsers: number;
  /** Onboarded through the faucet but not yet traded. */
  faucetOnboards: number;
  /** Traded within the last 7 days (needs a live-fold `lastActiveMs`). */
  activeUsers7d: number;
  /** Faucet claimers who went on to trade / total faucet claimers → a conversion %. */
  faucetConverted: number;
  faucetTotal: number;

  totalVolume: number;
  totalTrades: number;
  totalPoints: number;

  /** Traders whose net realized PnL is positive, over `tradingUsers`. */
  netPositiveTraders: number;
  /** Mean net PnL across trading users (DUSDC). */
  avgNetPnl: number;

  /** Resolved-close outcomes: live board tallies + Season-1 carryover history. */
  wins: number;
  losses: number;
  resolvedPositions: number;
  winRate: number; // 0..1
  lossRate: number; // 0..1
  /** Net realized PnL across users, live off the board (Season-1 carryover already folded
   *  in, losing bets included). DUSDC, signed. */
  realizedPnl: number;

  /** Top traders by net PnL (trading users only). */
  topTraders: TopTrader[];
  /** Cumulative distinct traders over time, by first resolved bet — or newest board
   *  activity for a live trader with no carried-over history, so the curve tracks the
   *  board as new users join. */
  joinSeries: UserJoinPoint[];
}

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Compute the admin user/performance stats. `rows` is the Skew board; `history` is
 * the resolved-history-by-owner (won/lost with timestamps). `topN` caps the top-trader
 * table.
 */
export function computeSkewUserStats(
  rows: V2LeaderboardRow[],
  history: Record<string, PastPrediction[]>,
  nowMs: number,
  topN = 6,
): SkewUserStats {
  const traders = rows.filter((r) => r.trades > 0);
  const activeCut = nowMs - 7 * DAY_MS;

  const totalVolume = rows.reduce((s, r) => s + r.volume, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const totalPoints = rows.reduce((s, r) => s + r.points, 0);

  const netPositiveTraders = traders.filter((r) => (r.netPnl ?? 0) > 0).length;
  const sumNetPnl = traders.reduce((s, r) => s + (r.netPnl ?? 0), 0);

  const faucetRows = rows.filter((r) => r.viaFaucet);
  const faucetConverted = faucetRows.filter((r) => r.trades > 0).length;

  // Win / loss + realized PnL — LIVE, no longer frozen to the carryover snapshot.
  //   realizedPnl: the board's net across users. Board netPnl already folds the Season-1
  //     carryover (mergeLegacyCarryover) in with live 8-06 PnL, and it includes losing
  //     bets — a settled loser is redeemed at zero payout, so its −premium is in netPnl —
  //     so this is complete, not just the winners.
  //   wins/losses: the board's per-owner resolved-close tallies (live 8-06) PLUS the
  //     carryover history (Season 1) for continuity. The two never overlap (different
  //     deployments); the seed carries netPnl while the history JSON carries the won/lost
  //     split, so pairing board-netPnl with board+history counts double-counts neither.
  let liveWins = 0;
  let liveLosses = 0;
  for (const r of rows) {
    liveWins += r.wins ?? 0;
    liveLosses += r.losses ?? 0;
  }
  let histWins = 0;
  let histLosses = 0;
  for (const list of Object.values(history)) {
    for (const p of list) {
      if (p.result === 'won') histWins += 1;
      else histLosses += 1;
    }
  }
  const wins = liveWins + histWins;
  const losses = liveLosses + histLosses;
  const realizedPnl = sumNetPnl;
  const resolvedPositions = wins + losses;

  // Cumulative distinct traders over time (the "users joining" curve). Fold in the LIVE
  // board, not just the resolved history: place each trader at the best timestamp we
  // have — the earliest resolved-bet close when their history is known (accurate, and what
  // shapes the historical curve), otherwise their newest board activity as the only proxy
  // we have for a live joiner with no carried-over history. Reading history ALONE (the old
  // behavior) froze the curve at the carryover snapshot while new users kept joining the
  // board: they have no carryover history, so they never appeared on the curve.
  const firstBetMs = new Map<string, number>();
  for (const [owner, list] of Object.entries(history)) {
    if (list.length) firstBetMs.set(owner.toLowerCase(), Math.min(...list.map((p) => p.settledAt)));
  }
  const joinTimes: number[] = [];
  const counted = new Set<string>();
  for (const r of traders) {
    const key = r.owner.toLowerCase();
    counted.add(key);
    joinTimes.push(firstBetMs.get(key) ?? r.lastActiveMs ?? nowMs);
  }
  // Carryover traders not on the live board still count as earlier joiners.
  for (const [key, ms] of firstBetMs) if (!counted.has(key)) joinTimes.push(ms);
  joinTimes.sort((a, b) => a - b);
  const joinSeries: UserJoinPoint[] = joinTimes.map((t, i) => ({
    x: t,
    y: i + 1,
    label: fmtDay(t),
  }));

  const topTraders: TopTrader[] = [...traders]
    .sort((a, b) => (b.netPnl ?? 0) - (a.netPnl ?? 0))
    .slice(0, topN)
    .map((r) => ({ owner: r.owner, netPnl: r.netPnl ?? 0, trades: r.trades, volume: r.volume, points: r.points }));

  return {
    totalUsers: rows.length,
    tradingUsers: traders.length,
    faucetOnboards: faucetRows.filter((r) => r.trades === 0).length,
    activeUsers7d: rows.filter((r) => (r.lastActiveMs ?? 0) >= activeCut).length,
    faucetConverted,
    faucetTotal: faucetRows.length,
    totalVolume,
    totalTrades,
    totalPoints,
    netPositiveTraders,
    avgNetPnl: traders.length ? sumNetPnl / traders.length : 0,
    wins,
    losses,
    resolvedPositions,
    winRate: resolvedPositions ? wins / resolvedPositions : 0,
    lossRate: resolvedPositions ? losses / resolvedPositions : 0,
    realizedPnl,
    topTraders,
    joinSeries,
  };
}
