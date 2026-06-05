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

export interface PastPrediction {
  key: string;
  oracleId: string;
  underlying: string;
  up: boolean;
  strike: number; // float
  expiry: number; // ms
  settledAt: number; // ms — when it closed (last activity)
  result: 'won' | 'lost';
  contracts: number; // size that resolved
  cost: number; // DUSDC staked (cost basis)
  payout: number; // DUSDC returned
  pnl: number; // DUSDC, signed (payout − cost)
  roi: number; // ratio (pnl / cost)
  entryPrice: number; // 0..1 implied
  source: PositionSummary; // raw row — lets the share card fetch this position's spark
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

/**
 * Split a manager's positions into the closed-history rows (newest first) and the
 * aggregate win/loss stats over them.
 */
export function derivePortfolioHistory(positions: PositionSummary[]): {
  history: PastPrediction[];
  stats: WinStats;
} {
  const history = positions
    .filter((p) => CLOSED.has(p.status))
    .map(toPrediction)
    .sort((a, b) => b.settledAt - a.settledAt);

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
