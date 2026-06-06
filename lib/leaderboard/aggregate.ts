/**
 * lib/leaderboard/aggregate.ts — pure aggregation for the trader leaderboard.
 *
 * Single-stage by design: fold the GLOBAL position event streams
 * (`/positions/minted`, `/positions/redeemed`) + the manager list into per-owner
 * rows, then score each row with the shared Points formula (lib/points/score.ts).
 * Everything is computed from the cheap global streams — NO per-manager fan-out —
 * so the board is complete for every trader and never hits the server rate limit.
 *
 * The leaderboard ranks by Points (and Volume). Authoritative win rate and
 * realized+unrealized PnL live on each trader's Portfolio; here, the Points
 * "performance" input is a realized-net proxy (payout − cost) within the window.
 *
 * SCALING: minted.cost / redeemed.payout are @6dec base units → de-scale with
 * fromQuote, never elsewhere.
 */
import { fromQuote } from '@/config/scale';
import { pointsFromInput, type PointsBreakdown } from '@/lib/points/score';
import type {
  PositionMintedEvent,
  PositionRedeemedEvent,
  ManagerRow,
} from '@/lib/api/types';

const DAY_MS = 86_400_000;

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
  /** Every PredictManager this owner controls (kept for cross-linking). */
  managerIds: string[];
  /** The trader's Points score + transparent breakdown (the ranking metric). */
  points: PointsBreakdown;
}

/** A minted lot awaiting redemption, for FIFO holding-time matching. */
interface Lot {
  qty: number; // units (de-scaled)
  costPerUnit: number; // DUSDC per unit
  ts: number; // mint timestamp (ms)
}

/** `oracle:expiry:strike:is_up` — the position identity a redeem closes against. */
function keyOf(e: { oracle_id: string; expiry: number; strike: number; is_up: boolean }): string {
  return `${e.oracle_id}:${e.expiry}:${e.strike}:${e.is_up}`;
}

/**
 * Liquidity-weighted holding time (Σ cost·days) for one owner, by FIFO-matching
 * their redeems against their earliest open mint lots per position key. Lots
 * still open at the end are held to `nowMs`. Redeems with no matching mint in the
 * window contribute nothing (the window-bounded caveat).
 */
function holdingDusdcDays(
  mints: PositionMintedEvent[],
  redeems: PositionRedeemedEvent[],
  nowMs: number,
): number {
  const lotsByKey = new Map<string, Lot[]>();
  for (const m of mints) {
    const qty = fromQuote(m.quantity);
    if (qty <= 0) continue;
    const k = keyOf(m);
    const lot: Lot = { qty, costPerUnit: fromQuote(m.cost) / qty, ts: m.checkpoint_timestamp_ms };
    const list = lotsByKey.get(k);
    if (list) list.push(lot);
    else lotsByKey.set(k, [lot]);
  }
  const redeemsByKey = new Map<string, PositionRedeemedEvent[]>();
  for (const r of redeems) {
    const k = keyOf(r);
    const list = redeemsByKey.get(k);
    if (list) list.push(r);
    else redeemsByKey.set(k, [r]);
  }

  let total = 0;
  for (const [k, lots] of lotsByKey) {
    lots.sort((a, b) => a.ts - b.ts);
    const rs = (redeemsByKey.get(k) ?? []).slice().sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms);
    let li = 0;
    for (const r of rs) {
      let remaining = fromQuote(r.quantity);
      while (remaining > 1e-9 && li < lots.length) {
        const lot = lots[li];
        const take = Math.min(remaining, lot.qty);
        const days = Math.max(0, (r.checkpoint_timestamp_ms - lot.ts) / DAY_MS);
        total += take * lot.costPerUnit * days;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) li++;
      }
    }
    for (; li < lots.length; li++) {
      const lot = lots[li];
      if (lot.qty <= 1e-9) continue;
      total += lot.qty * lot.costPerUnit * Math.max(0, (nowMs - lot.ts) / DAY_MS);
    }
  }
  return total;
}

/**
 * Fold global event streams into scored per-owner rows, ranked by Points desc.
 * Owners with no trading activity in the window are omitted. `nowMs` dates the
 * holding time of still-open positions (pass Date.now() in the app).
 */
export function aggregateLeaderboard(
  minted: PositionMintedEvent[],
  redeemed: PositionRedeemedEvent[],
  managers: ManagerRow[],
  nowMs: number,
): LeaderboardRow[] {
  // owner → their manager ids (for cross-linking to the Portfolio).
  const ownerManagers = new Map<string, string[]>();
  for (const m of managers) {
    const list = ownerManagers.get(m.owner);
    if (list) list.push(m.manager_id);
    else ownerManagers.set(m.owner, [m.manager_id]);
  }

  // Per-owner running totals + the raw events needed for FIFO holding time.
  interface Acc {
    volume: number;
    trades: number;
    redeems: number;
    payout: number;
    lastActiveMs: number;
    mints: PositionMintedEvent[];
    redeemEvents: PositionRedeemedEvent[];
  }
  const acc = new Map<string, Acc>();
  const ensure = (owner: string) => {
    let a = acc.get(owner);
    if (!a) {
      a = { volume: 0, trades: 0, redeems: 0, payout: 0, lastActiveMs: 0, mints: [], redeemEvents: [] };
      acc.set(owner, a);
    }
    return a;
  };

  for (const e of minted) {
    const a = ensure(e.trader);
    a.volume += fromQuote(e.cost);
    a.trades += 1;
    a.mints.push(e);
    if (e.checkpoint_timestamp_ms > a.lastActiveMs) a.lastActiveMs = e.checkpoint_timestamp_ms;
  }
  for (const e of redeemed) {
    const a = ensure(e.owner);
    a.payout += fromQuote(e.payout);
    a.redeems += 1;
    a.redeemEvents.push(e);
    if (e.checkpoint_timestamp_ms > a.lastActiveMs) a.lastActiveMs = e.checkpoint_timestamp_ms;
  }

  const rows: LeaderboardRow[] = [];
  for (const [owner, a] of acc) {
    const dusdcDaysHeld = holdingDusdcDays(a.mints, a.redeemEvents, nowMs);
    // Performance input: realized-net proxy within the window (floored at 0 in
    // the formula → losses never subtract, you always earn points).
    const points = pointsFromInput({ volume: a.volume, netPnl: a.payout - a.volume, dusdcDaysHeld });
    rows.push({
      owner,
      volume: a.volume,
      trades: a.trades,
      redeems: a.redeems,
      payout: a.payout,
      lastActiveMs: a.lastActiveMs,
      managerIds: ownerManagers.get(owner) ?? [],
      points,
    });
  }

  return rows.sort((x, y) => y.points.total - x.points.total);
}

export type SortKey = 'points' | 'volume';

/** Sort a copy of the rows by the chosen column (desc). */
export function sortRows(rows: LeaderboardRow[], key: SortKey): LeaderboardRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (key === 'volume') {
      if (b.volume === a.volume) return b.points.total - a.points.total;
      return b.volume - a.volume;
    }
    // points (default): rank by total, break ties by volume.
    if (b.points.total === a.points.total) return b.volume - a.volume;
    return b.points.total - a.points.total;
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
