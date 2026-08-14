/**
 * lib/portfolio/history.ts — derive a trader's *past* predictions and win/loss
 * stats from the manager's position summaries.
 *
 * The server returns every position the manager ever held in one list, tagged by
 * status (verified live, broader than the legacy type):
 *   • active      — still open / live (shown as cards)
 *   • redeemable   — settled in-the-money, not yet claimed (shown in "Ready to redeem")
 *   • lost         — settled out-of-the-money, worthless
 *   • redeemed     — fully closed, payout claimed (or sold back early)
 *
 * "Past predictions" = the *decided & done* ones: `redeemed` + `lost`.
 * `redeemable` is intentionally excluded here — it's still actionable money and
 * lives in the redeem section until claimed, at which point it becomes `redeemed`.
 *
 * Realized PnL is computed as `total_payout − total_cost`, which is correct for
 * BOTH outcomes — a `lost` row carries `realized_pnl: 0` (nothing was redeemed)
 * but `total_payout: 0`, so payout−cost recovers the true −cost loss. Amounts are
 * @6dec base units; we de-scale here so the UI never re-scales.
 */
import { fromQuote, toFloat } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';
import type { RangePosition } from '@/lib/ranges/aggregate';

export interface PastPrediction {
  key: string;
  oracleId: string;
  underlying: string;
  up: boolean;
  strike: number; // float
  /** Present for a vertical-range row — renders the band instead of strike±. */
  band?: { lower: number; higher: number };
  expiry: number; // ms
  settledAt: number; // ms — when it closed (last activity)
  result: 'won' | 'lost';
  contracts: number; // size that resolved
  cost: number; // DUSDC staked (cost basis)
  payout: number; // DUSDC returned
  pnl: number; // DUSDC, signed (payout − cost)
  roi: number; // ratio (pnl / cost)
  entryPrice: number; // 0..1 implied
  /** Leverage multiple used (e.g. 3 ⇒ 3×), when the trade was leveraged (v2 only).
   *  Undefined/1 for plain bets and all legacy trades. */
  leverage?: number;
  /** Raw binary row — lets the share card fetch its spark. Absent for ranges. */
  source?: PositionSummary;
  /** True for a trade carried over from an earlier deployment (6-24 → 8-06). Renders
   *  seamlessly by default; lets the UI add a subtle "6-24" tag if it wants. See
   *  lib/portfolio/legacy-history. */
  legacy?: boolean;
}

export interface EquityPoint {
  t: number; // settledAt ms
  cumulative: number; // running realized PnL after this trade (DUSDC, signed)
  pnl: number; // this trade's PnL (DUSDC, signed)
  result: 'won' | 'lost';
  index: number; // 1-based trade number in chronological order
}

/**
 * Chronological cumulative-PnL ("equity") curve from the closed-history rows.
 * `history` arrives newest-first, so we re-sort ascending and accumulate. One
 * point per settled trade — the renderer prepends the zero baseline so this
 * stays a pure per-trade series (and an empty history → an empty curve).
 */
export function equityCurve(history: PastPrediction[]): EquityPoint[] {
  const asc = [...history].sort((a, b) => a.settledAt - b.settledAt);
  let cum = 0;
  return asc.map((h, i) => {
    cum += h.pnl;
    return { t: h.settledAt, cumulative: cum, pnl: h.pnl, result: h.result, index: i + 1 };
  });
}

export type PerfRangeKey = '1D' | '1W' | '1M' | 'All';

/** Trailing time windows for the performance filter + shareable card. `All` = Infinity. */
export const PERF_RANGES: { key: PerfRangeKey; ms: number; label: string }[] = [
  { key: '1D', ms: 24 * 3_600_000, label: 'Last 24h' },
  { key: '1W', ms: 7 * 24 * 3_600_000, label: 'Last 7 days' },
  { key: '1M', ms: 30 * 24 * 3_600_000, label: 'Last 30 days' },
  { key: 'All', ms: Infinity, label: 'All time' },
];

export interface PerfWindow {
  total: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  realizedPnl: number; // DUSDC, signed
  staked: number; // DUSDC cost basis
  avgRoi: number; // realizedPnl / staked
  best: number; // best single-trade PnL
  streak: { count: number; won: boolean } | null;
  /** Within-window cumulative realized PnL, oldest→newest (rebased to 0 at window start). */
  curve: number[];
}

/**
 * Track-record stats over a trailing time window — the data behind the shareable
 * performance card at any of the 1D/1W/1M/All ranges. Filters the closed history to
 * `[now − rangeMs, now]` (`rangeMs = Infinity` → all-time), recomputes the same
 * aggregates as `derivePortfolioHistory`, and rebases the curve to 0 at the window
 * start so the headline PnL equals the curve's endpoint. `unclaimed` is omitted on
 * purpose — it's a live count, not part of a settled window.
 */
export function perfWindow(history: PastPrediction[], rangeMs: number, now: number): PerfWindow {
  const cutoff = rangeMs === Infinity ? -Infinity : now - rangeMs;
  const rows = history.filter((h) => h.settledAt >= cutoff);
  const wins = rows.filter((h) => h.result === 'won').length;
  const losses = rows.length - wins;
  const realizedPnl = rows.reduce((s, h) => s + h.pnl, 0);
  const staked = rows.reduce((s, h) => s + h.cost, 0);
  const pnls = rows.map((h) => h.pnl);

  // `history` arrives newest-first, so the streak is the leading run from the
  // newest close still inside the window.
  let streak: PerfWindow['streak'] = null;
  if (rows.length > 0) {
    const r = rows[0].result;
    let count = 0;
    for (const h of rows) {
      if (h.result !== r) break;
      count++;
    }
    streak = { count, won: r === 'won' };
  }

  // Curve: oldest→newest cumulative within the window.
  const asc = [...rows].sort((a, b) => a.settledAt - b.settledAt);
  let cum = 0;
  const curve = asc.map((h) => (cum += h.pnl));

  return {
    total: rows.length,
    wins,
    losses,
    winRate: rows.length > 0 ? wins / rows.length : 0,
    realizedPnl,
    staked,
    avgRoi: staked > 0 ? realizedPnl / staked : 0,
    best: pnls.length ? Math.max(...pnls) : 0,
    streak,
    curve,
  };
}

/**
 * Cumulative win-rate curve (each point 0..1) over the settled history, in
 * chronological order — the running share of bets won after each close. `history`
 * arrives newest-first, so we re-sort ascending like equityCurve. The FINAL point
 * equals the overall win rate (WinStats.winRate), so the curve and the headline
 * number always agree. An empty history → an empty curve.
 */
export function winRateSeries(history: PastPrediction[]): number[] {
  const asc = [...history].sort((a, b) => a.settledAt - b.settledAt);
  let wins = 0;
  return asc.map((h, i) => {
    if (h.result === 'won') wins += 1;
    return wins / (i + 1);
  });
}

export interface WinStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  realizedPnl: number; // DUSDC, signed — sum over closed
  staked: number; // DUSDC total cost basis over closed
  best: number; // best single PnL
  worst: number; // worst single PnL
  /** Current run from the most-recent close, e.g. { result:'won', count:3 }. */
  streak: { result: 'won' | 'lost'; count: number } | null;
  /** Settled wins not yet claimed (live in the redeem section, not in history). */
  unclaimed: number;
}

const CLOSED = new Set(['redeemed', 'lost']);

/**
 * Statuses meaning "settled, in-the-money, not yet claimed" — redeeming is final
 * and must use the permissionless settled path. Verified live (2026-06-06) the
 * server emits `redeemable`; `settled` / `awaiting_settlement` are accepted
 * defensively in case the schema gains them.
 */
export const REDEEMABLE_STATUSES: ReadonlySet<string> = new Set([
  'redeemable',
  'settled',
  'awaiting_settlement',
]);

export const isRedeemableStatus = (status: string): boolean => REDEEMABLE_STATUSES.has(status);

/** One closed position → a display row. PnL = payout − cost (see file header). */
function toPrediction(p: PositionSummary): PastPrediction {
  const cost = fromQuote(p.total_cost);
  const payout = fromQuote(p.total_payout);
  const pnl = payout - cost;
  const contracts = fromQuote(p.redeemed_quantity || p.open_quantity || p.minted_quantity);
  return {
    key: `${p.oracle_id}-${p.strike}-${p.is_up}-${p.last_activity_at}`,
    oracleId: p.oracle_id,
    underlying: p.underlying_asset,
    up: p.is_up,
    strike: toFloat(p.strike),
    expiry: p.expiry,
    settledAt: p.last_activity_at,
    result: pnl > 0 ? 'won' : 'lost',
    contracts,
    cost,
    payout,
    pnl,
    roi: cost > 0 ? pnl / cost : 0,
    entryPrice: toFloat(p.average_entry_price),
    source: p,
  };
}

/** A fully-closed vertical range → a history row. PnL = payout − cost. */
function rangeToPrediction(p: RangePosition & { underlying: string }): PastPrediction {
  const cost = fromQuote(p.totalCost);
  const payout = fromQuote(p.totalPayout);
  const pnl = payout - cost;
  return {
    key: `range-${p.oracleId}-${p.lowerStrike}-${p.higherStrike}-${p.lastActivityAt}`,
    oracleId: p.oracleId,
    underlying: p.underlying || 'BTC',
    up: true, // unused when `band` is present
    strike: 0,
    band: { lower: toFloat(p.lowerStrike), higher: toFloat(p.higherStrike) },
    expiry: p.expiry,
    settledAt: p.lastActivityAt,
    result: pnl > 0 ? 'won' : 'lost',
    contracts: fromQuote(p.redeemedQty),
    cost,
    payout,
    pnl,
    roi: cost > 0 ? pnl / cost : 0,
    entryPrice: p.avgEntryPrice / 1e9,
  };
}

/** Closed (fully redeemed) ranges → history rows. */
export function deriveRangeHistory(positions: (RangePosition & { underlying: string })[]): PastPrediction[] {
  return positions.filter((p) => p.redeemedQty > 0 && p.openQty <= 0).map(rangeToPrediction);
}

/**
 * Split a manager's positions into the closed-history rows (newest first) and the
 * aggregate win/loss stats over them. `extraRows` (e.g. closed ranges) are merged
 * into the same history + stats.
 */
export function derivePortfolioHistory(
  positions: PositionSummary[],
  extraRows: PastPrediction[] = [],
): {
  history: PastPrediction[];
  stats: WinStats;
} {
  const history = [...positions.filter((p) => CLOSED.has(p.status)).map(toPrediction), ...extraRows].sort(
    (a, b) => b.settledAt - a.settledAt,
  );

  const unclaimed = positions.filter((p) => p.status === 'redeemable').length;

  const wins = history.filter((h) => h.result === 'won').length;
  const losses = history.length - wins;
  const realizedPnl = history.reduce((s, h) => s + h.pnl, 0);
  const staked = history.reduce((s, h) => s + h.cost, 0);
  const pnls = history.map((h) => h.pnl);

  // Current streak: leading run of identical results from the newest close.
  let streak: WinStats['streak'] = null;
  if (history.length > 0) {
    const r = history[0].result;
    let count = 0;
    for (const h of history) {
      if (h.result !== r) break;
      count++;
    }
    streak = { result: r, count };
  }

  return {
    history,
    stats: {
      total: history.length,
      wins,
      losses,
      winRate: history.length > 0 ? wins / history.length : 0,
      realizedPnl,
      staked,
      best: pnls.length ? Math.max(...pnls) : 0,
      worst: pnls.length ? Math.min(...pnls) : 0,
      streak,
      unclaimed,
    },
  };
}
