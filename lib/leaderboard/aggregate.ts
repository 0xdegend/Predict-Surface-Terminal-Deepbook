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
  ManagerSummary,
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
  /** Every PredictManager this owner controls (for the PnL enrichment pass). */
  managerIds: string[];
  /** Stage-2 PnL fields — undefined until summaries are folded in. */
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  accountValue?: number;
  openPositions?: number;
  /** True once this row's summaries have been fetched + attached. */
  pnlLoaded?: boolean;
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
 * Stage 2: fold authoritative manager summaries into the rows. An owner's PnL is
 * the sum of realized + unrealized across all their managers. Rows whose
 * managers aren't in the map are returned unchanged (still pnlLoaded=false).
 */
export function attachPnl(
  rows: LeaderboardRow[],
  summaries: Map<string, ManagerSummary>,
): LeaderboardRow[] {
  return rows.map((r) => {
    const mgrs = r.managerIds
      .map((id) => summaries.get(id))
      .filter((s): s is ManagerSummary => s != null);
    if (mgrs.length === 0) return r;
    const realizedPnl = mgrs.reduce((s, m) => s + fromQuote(m.realized_pnl), 0);
    const unrealizedPnl = mgrs.reduce((s, m) => s + fromQuote(m.unrealized_pnl), 0);
    const accountValue = mgrs.reduce((s, m) => s + fromQuote(m.account_value), 0);
    const openPositions = mgrs.reduce((s, m) => s + (m.open_positions ?? 0), 0);
    return {
      ...r,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      accountValue,
      openPositions,
      pnlLoaded: true,
    };
  });
}

export type SortKey = 'volume' | 'trades' | 'pnl';

/** Sort a copy of the rows by the chosen column (desc). Undefined PnL sinks. */
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
