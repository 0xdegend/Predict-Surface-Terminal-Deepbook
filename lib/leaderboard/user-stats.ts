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
  /** The raw sorted join timestamps behind `joinSeries` — so the UI can rebuild the
   *  curve for any time window (1d / 7d / 14d / all) via `buildJoinCurve`. */
  joinTimes: number[];
}

/** A smooth, windowed join curve + the count of joiners inside the window. */
export interface JoinCurve {
  /** Evenly-spaced points (so the chart's monotone curve reads smooth, not jagged).
   *  For a window the y is REBASED to 0 at the window start (new joiners only); for
   *  all-time it is the running total. */
  series: UserJoinPoint[];
  /** How many distinct traders joined inside the window. */
  joined: number;
  /** Human label for the window, e.g. "7 days" / "all time". */
  windowLabel: string;
}

/**
 * Build a SMOOTH join curve for a time window from the raw join timestamps.
 *
 * The raw timestamps cluster (many wallets first settle around the same moment), so
 * plotting them directly gives a jagged, near-vertical step. This resamples into
 * `buckets` EVENLY-SPACED time points and plots the cumulative count at each — even
 * x-spacing plus the chart's monotone curve read as a clean growth curve. `windowMs =
 * null` is all-time (starts at the first join, running total); otherwise the curve is
 * rebased to 0 at `now - windowMs` and counts only new joiners in that window, so it
 * answers "how many joined in the last N days". Pure + deterministic (pass `nowMs`).
 */
export function buildJoinCurve(
  joinTimes: number[], // sorted ascending
  windowMs: number | null,
  nowMs: number,
  buckets = 48,
): JoinCurve {
  const windowLabel = windowMs == null ? 'all time' : `${Math.round(windowMs / DAY_MS)} days`;
  if (joinTimes.length === 0) return { series: [], joined: 0, windowLabel };

  const end = nowMs;
  const start = windowMs == null ? joinTimes[0] : nowMs - windowMs;
  // Joiners strictly before the window are the rebase baseline (all-time → 0, since
  // start is the first join). New joiners inside [start, end] are what the curve shows.
  const baseCount = joinTimes.filter((t) => t < start).length;
  const joined = joinTimes.filter((t) => t >= start && t <= end).length;

  const span = Math.max(1, end - start);
  const n = Math.max(2, buckets);
  const series: UserJoinPoint[] = [];
  let ptr = 0; // monotone pointer — both arrays are time-ordered, so this is O(n + m)
  for (let i = 0; i < n; i++) {
    const t = start + (span * i) / (n - 1);
    while (ptr < joinTimes.length && joinTimes[ptr] <= t) ptr++;
    series.push({ x: t, y: ptr - baseCount, label: fmtDay(t) });
  }
  return { series, joined, windowLabel };
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
    joinTimes,
  };
}
