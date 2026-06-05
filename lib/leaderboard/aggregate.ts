/**
 * lib/leaderboard/aggregate.ts — pure aggregation for the trader leaderboard.
 *
 * Two-stage by design so the page paints fast and stays honest:
 *   Stage 1 (this file, `aggregateLeaderboard`): fold the GLOBAL position event
 *     streams (`/positions/minted`, `/positions/redeemed`) + the full manager
 *     list into per-owner rows. Volume and activity are COMPLETE and accurate
 *     within the fetched window — no per-manager calls needed.
 *   Stage 2 (`attachPnl`): authoritative realized/unrealized PnL is only in
 *     `/managers/:id/summary`, so the hook fetches summaries for the top
 *     contenders and folds them in here.
 *
 * SCALING: minted.cost, redeemed.payout, and the summary pnl/value fields are
 * all @6dec base units → de-scale with fromQuote, never elsewhere.
 */
import { fromQuote } from '@/config/scale';
import type {
  PositionMintedEvent,
  PositionRedeemedEvent,
  ManagerRow,
} from '@/lib/api/types';

export interface LeaderboardRow {
  /** Trader address (the human; aggregates across all their managers). */
  owner: string;
  /** Total DUSDC paid to mint, summed over the window. */
  volume: number;
  /** Number of mint events. */
  trades: number;
  /** Number of redeem events. */
  redeems: number;
  /** Total DUSDC received from redeems, summed over the window. */
  payout: number;
  /** Most recent activity (ms epoch) across mint + redeem. */
  lastActiveMs: number;
  /** Every PredictManager this owner controls (for the enrichment pass). */
  managerIds: string[];
  /** Stage-2 fields — undefined until manager summaries/positions are folded in. */
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  accountValue?: number;
  openPositions?: number;
  /** Decided (settled & done) positions, the win-rate denominator. */
  wins?: number;
  decided?: number;
  /** wins / decided, 0..1 — undefined if no decided positions yet. */
  winRate?: number;
  /** True once this row's enrichment has been fetched + attached. */
  pnlLoaded?: boolean;
}

/**
 * Per-manager enrichment, already de-scaled by the hook. PnL is from the
 * authoritative manager summary; wins/decided come from the canonical
 * `derivePortfolioHistory` over the manager's position list, so the leaderboard
 * and the portfolio agree on what a "win" is.
 */
export interface ManagerEnrichment {
  realizedPnl: number;
  unrealizedPnl: number;
  accountValue: number;
  openPositions: number;
  wins: number;
  decided: number;
}

function blankRow(owner: string): LeaderboardRow {
  return {
    owner,
    volume: 0,
    trades: 0,
    redeems: 0,
    payout: 0,
    lastActiveMs: 0,
    managerIds: [],
  };
}

/**
 * Stage 1: fold global event streams into per-owner rows, sorted by volume desc.
 * Owners with no trading activity in the window are omitted (a leaderboard of
 * empty accounts is noise).
 */
export function aggregateLeaderboard(
  minted: PositionMintedEvent[],
  redeemed: PositionRedeemedEvent[],
  managers: ManagerRow[],
): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>();
  const ensure = (owner: string) => {
    let r = rows.get(owner);
    if (!r) {
      r = blankRow(owner);
      rows.set(owner, r);
    }
    return r;
  };

  // owner → their manager ids (used by the PnL enrichment pass).
  const ownerManagers = new Map<string, string[]>();
  for (const m of managers) {
    const list = ownerManagers.get(m.owner);
    if (list) list.push(m.manager_id);
    else ownerManagers.set(m.owner, [m.manager_id]);
  }

  for (const e of minted) {
    const r = ensure(e.trader);
    r.volume += fromQuote(e.cost);
    r.trades += 1;
    if (e.checkpoint_timestamp_ms > r.lastActiveMs) r.lastActiveMs = e.checkpoint_timestamp_ms;
  }
  for (const e of redeemed) {
    const r = ensure(e.owner);
    r.payout += fromQuote(e.payout);
    r.redeems += 1;
    if (e.checkpoint_timestamp_ms > r.lastActiveMs) r.lastActiveMs = e.checkpoint_timestamp_ms;
  }

  for (const [owner, r] of rows) {
    r.managerIds = ownerManagers.get(owner) ?? [];
  }

  return [...rows.values()].sort((a, b) => b.volume - a.volume);
}

/**
 * Stage 2: fold per-manager enrichment into the rows. An owner's PnL and
 * win/loss are summed across all their managers. Rows whose managers aren't in
 * the map are returned unchanged (still pnlLoaded=false).
 */
export function attachEnrichment(
  rows: LeaderboardRow[],
  enrich: Map<string, ManagerEnrichment>,
): LeaderboardRow[] {
  return rows.map((r) => {
    const parts = r.managerIds
      .map((id) => enrich.get(id))
      .filter((e): e is ManagerEnrichment => e != null);
    if (parts.length === 0) return r;
    const realizedPnl = parts.reduce((s, m) => s + m.realizedPnl, 0);
    const unrealizedPnl = parts.reduce((s, m) => s + m.unrealizedPnl, 0);
    const accountValue = parts.reduce((s, m) => s + m.accountValue, 0);
    const openPositions = parts.reduce((s, m) => s + m.openPositions, 0);
    const wins = parts.reduce((s, m) => s + m.wins, 0);
    const decided = parts.reduce((s, m) => s + m.decided, 0);
    return {
      ...r,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      accountValue,
      openPositions,
      wins,
      decided,
      winRate: decided > 0 ? wins / decided : undefined,
      pnlLoaded: true,
    };
  });
}

export type SortKey = 'volume' | 'trades' | 'winrate' | 'pnl';

/** Sort a copy of the rows by the chosen column (desc). Unloaded values sink. */
export function sortRows(rows: LeaderboardRow[], key: SortKey): LeaderboardRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (key === 'trades') return b.trades - a.trades;
    if (key === 'pnl') {
      const av = a.totalPnl ?? Number.NEGATIVE_INFINITY;
      const bv = b.totalPnl ?? Number.NEGATIVE_INFINITY;
      if (av === bv) return b.volume - a.volume;
      return bv - av;
    }
    if (key === 'winrate') {
      // Rank by win rate; break ties by sample size so 1/1 doesn't beat 9/10.
      const av = a.winRate ?? Number.NEGATIVE_INFINITY;
      const bv = b.winRate ?? Number.NEGATIVE_INFINITY;
      if (av === bv) return (b.decided ?? 0) - (a.decided ?? 0);
      return bv - av;
    }
    return b.volume - a.volume;
  });
  return copy;
}

export interface LeaderboardTotals {
  traders: number;
  volume: number;
  trades: number;
}

export function leaderboardTotals(rows: LeaderboardRow[]): LeaderboardTotals {
  return rows.reduce<LeaderboardTotals>(
    (acc, r) => {
      acc.traders += 1;
      acc.volume += r.volume;
      acc.trades += r.trades;
      return acc;
    },
    { traders: 0, volume: 0, trades: 0 },
  );
}
