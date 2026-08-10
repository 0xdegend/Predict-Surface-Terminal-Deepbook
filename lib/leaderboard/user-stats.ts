/**
 * lib/leaderboard/user-stats.ts — Skew user + performance statistics for the admin.
 *
 * Two honest sources, combined:
 *   - the Skew leaderboard rows (carryover + faucet + any live-attributed activity):
 *     who the users are, their volume / trades / net PnL / points, and who's active;
 *   - the resolved trade history (won/lost per position, with close timestamps):
 *     the only place a real WIN RATE and a JOIN-OVER-TIME curve can come from, since
 *     the board rows only carry aggregates.
 *
 * Pure + deterministic (pass `nowMs`), so it unit-tests against fixed inputs. Counts
 * grow on their own as the builder code gets wired and users trade on the live
 * deployment — this reads whatever is in the rows/history, no per-deployment branch.
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

  /** Resolved-position outcomes (from trade history). */
  wins: number;
  losses: number;
  resolvedPositions: number;
  winRate: number; // 0..1
  lossRate: number; // 0..1
  /** Realized PnL summed across every resolved position (DUSDC, signed). */
  realizedPnl: number;

  /** Top traders by net PnL (trading users only). */
  topTraders: TopTrader[];
  /** Cumulative distinct traders over time, by their first resolved bet. */
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

  // Win / loss + realized PnL from the resolved history.
  let wins = 0;
  let losses = 0;
  let realizedPnl = 0;
  for (const list of Object.values(history)) {
    for (const p of list) {
      if (p.result === 'won') wins += 1;
      else losses += 1;
      realizedPnl += p.pnl;
    }
  }
  const resolvedPositions = wins + losses;

  // Cumulative distinct traders by first resolved bet (their earliest close).
  const firstSeen: number[] = [];
  for (const list of Object.values(history)) {
    if (list.length === 0) continue;
    firstSeen.push(Math.min(...list.map((p) => p.settledAt)));
  }
  firstSeen.sort((a, b) => a - b);
  const joinSeries: UserJoinPoint[] = firstSeen.map((t, i) => ({
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
