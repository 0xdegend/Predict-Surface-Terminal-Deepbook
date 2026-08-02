/**
 * lib/leaderboard/v2-aggregate.ts — the real Season-2 board, folded from order
 * events (the v2 stand-in for the legacy global mint/redeem streams).
 *
 * Per owner: DUSDC staked (volume) and trade count from their mints; net realized
 * PnL by joining each redeem to its mint via `position_root_id` (settled pays the
 * terminal amount, a live close nets fees, a liquidation pays nothing);
 * liquidity-weighted holding time; and a Skew-attributed subset (bets that carried
 * the app's builder code). Points come from the shared formula so the board and
 * Portfolio agree.
 *
 * The fold is factored into INCREMENTAL primitives — `emptyLbState` + `foldOrderEvents`
 * (mutate a running state) + `finalizeRows` (state → ranked rows for a scope) — so the
 * SAME logic serves both the one-shot `aggregateV2Leaderboard` (below, unit-tested) AND
 * the persistent indexer (lib/leaderboard/v2-indexer.ts), which folds new events into
 * KV-persisted state so a board is never re-truncated by a windowed scan.
 *
 * Pure + deterministic (pass `nowMs`), so it unit-tests against fixed events.
 */
import { fromQuote } from '@/config/scale';
import { pointsFromInput } from '@/lib/points/score';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { V2LeaderboardRow } from './v2';

const DAY_MS = 86_400_000;
const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** Per-owner running tally. `skew*` mirror the full fields over only the subset of
 *  the owner's activity that carried the app's builder code (its mint did). */
export interface OwnerAcc {
  volume: number;
  trades: number;
  realizedCost: number;
  realizedPayout: number;
  daysHeldClosed: number; // liquidity-days from positions that have CLOSED
  skewVolume: number;
  skewTrades: number;
  skewRealizedCost: number;
  skewRealizedPayout: number;
  skewDaysHeldClosed: number;
  lastActiveMs: number;
}

/** A mint kept so a redeem arriving in a LATER fold cycle can still join it for cost
 *  basis + holding time. `redeemed` excludes it from the still-open holding loop while
 *  retaining its terms for further partial-close redeems; aged-out closed mints are
 *  pruned by the indexer. */
export interface OpenMint {
  owner: string;
  netPremium: number; // DUSDC (float)
  quantity: number; // base units, for the closed-fraction
  mintMs: number;
  isSkew: boolean;
  redeemed: boolean;
}

/** The full accumulator: per-owner tallies + the mint terms still needed for joins. */
export interface LbState {
  acc: Record<string, OwnerAcc>;
  open: Record<string, OpenMint>;
}

export const emptyLbState = (): LbState => ({ acc: {}, open: {} });

function ensure(acc: Record<string, OwnerAcc>, owner: string): OwnerAcc {
  let a = acc[owner];
  if (!a) {
    a = {
      volume: 0, trades: 0, realizedCost: 0, realizedPayout: 0, daysHeldClosed: 0,
      skewVolume: 0, skewTrades: 0, skewRealizedCost: 0, skewRealizedPayout: 0, skewDaysHeldClosed: 0,
      lastActiveMs: 0,
    };
    acc[owner] = a;
  }
  return a;
}

/**
 * Fold a batch of order events into `state` (mutating it). Mints are applied before
 * redeems so a redeem joins a mint from the SAME batch; redeems for earlier batches'
 * mints join via the persisted `state.open`. Idempotency is the caller's job — feed
 * each event exactly once (the indexer's cursor guarantees this; the one-shot path
 * starts from an empty state).
 */
export function foldOrderEvents(state: LbState, events: V2OrderEvent[], builderCodeId: string | undefined): void {
  // Pass 1 — mints establish volume/trades and the joinable terms.
  for (const e of events) {
    if (e.kind !== 'order_minted' || !e.owner || e.position_root_id == null) continue;
    const owner = e.owner;
    const ts = e.checkpoint_timestamp_ms ?? 0;
    const cost = fromQuote(n(e.net_premium));
    const isSkew = !!builderCodeId && e.builder_code_id === builderCodeId;
    const a = ensure(state.acc, owner);
    a.volume += cost;
    a.trades += 1;
    if (ts > a.lastActiveMs) a.lastActiveMs = ts;
    if (isSkew) {
      a.skewVolume += cost;
      a.skewTrades += 1;
    }
    state.open[String(e.position_root_id)] = {
      owner, netPremium: cost, quantity: n(e.quantity), mintMs: ts, isSkew, redeemed: false,
    };
  }
  // Pass 2 — redeems realize PnL against their mint (settled / live / liquidated rules).
  for (const e of events) {
    if (!/redeemed/i.test(e.kind ?? '') || !e.owner) continue;
    const owner = e.owner;
    const ts = e.checkpoint_timestamp_ms ?? 0;
    const a = ensure(state.acc, owner);
    if (ts > a.lastActiveMs) a.lastActiveMs = ts;

    const settled = /settled/i.test(e.kind ?? '');
    const liquidated = /liquidat/i.test(e.kind ?? '');
    const fees = settled ? 0 : n(e.trading_fee) + n(e.builder_fee) + n(e.penalty_fee);
    const gross = liquidated ? 0 : fromQuote(settled ? n(e.payout_amount) : n(e.redeem_amount));
    const payout = Math.max(0, gross - fromQuote(fees));

    const om = e.position_root_id != null ? state.open[String(e.position_root_id)] : undefined;
    let closedCost = 0;
    let days = 0;
    if (om) {
      const totalQty = om.quantity || n(e.quantity_closed);
      const closed = n(e.quantity_closed) || totalQty;
      const frac = totalQty > 0 ? closed / totalQty : 1;
      closedCost = om.netPremium * frac;
      days = Math.max(0, (ts - om.mintMs) / DAY_MS);
      om.redeemed = true;
    }
    a.realizedCost += closedCost;
    a.realizedPayout += payout;
    a.daysHeldClosed += closedCost * days;
    if (om?.isSkew) {
      a.skewRealizedCost += closedCost;
      a.skewRealizedPayout += payout;
      a.skewDaysHeldClosed += closedCost * days;
    }
  }
}

/**
 * Finalize `state` into ranked rows for a scope: `'all'` = the whole venue, `'skew'`
 * = only builder-code-attributed activity (volume/PnL count the subset). Still-open
 * mints earn holding time to `nowMs` here (transient, since `now` moves), so the
 * persisted `daysHeldClosed` never double-counts. Owners with no in-scope liquidity
 * (a redeem whose mint scrolled out, or no skew trades for the skew scope) are omitted.
 */
export function finalizeRows(
  state: LbState,
  builderCodeId: string | undefined,
  nowMs: number,
  scope: 'all' | 'skew' = 'all',
): V2LeaderboardRow[] {
  // Per-owner holding time from positions still open right now.
  const openDaysAll: Record<string, number> = {};
  const openDaysSkew: Record<string, number> = {};
  for (const om of Object.values(state.open)) {
    if (om.redeemed) continue;
    const d = om.netPremium * Math.max(0, (nowMs - om.mintMs) / DAY_MS);
    openDaysAll[om.owner] = (openDaysAll[om.owner] ?? 0) + d;
    if (om.isSkew) openDaysSkew[om.owner] = (openDaysSkew[om.owner] ?? 0) + d;
  }

  const rows: V2LeaderboardRow[] = [];
  for (const [owner, a] of Object.entries(state.acc)) {
    const skew = scope === 'skew';
    const volume = skew ? a.skewVolume : a.volume;
    const trades = skew ? a.skewTrades : a.trades;
    if (trades === 0) continue; // no in-scope liquidity to rank on
    const realizedPayout = skew ? a.skewRealizedPayout : a.realizedPayout;
    const realizedCost = skew ? a.skewRealizedCost : a.realizedCost;
    const daysHeld =
      (skew ? a.skewDaysHeldClosed : a.daysHeldClosed) +
      ((skew ? openDaysSkew[owner] : openDaysAll[owner]) ?? 0);
    const netPnl = realizedPayout - realizedCost;
    const points = pointsFromInput({ volume, netPnl, dusdcDaysHeld: daysHeld });
    rows.push({
      owner,
      points: points.total,
      volume,
      trades,
      netPnl,
      skewVolume: a.skewVolume,
      skewTrades: a.skewTrades,
      viaSkew: a.skewTrades > 0,
      lastActiveMs: a.lastActiveMs,
    });
  }
  return rows.sort((x, y) => y.points - x.points || y.volume - x.volume);
}

/**
 * Fold the fanned-out order feeds into ranked per-owner rows (one-shot, from empty
 * state). `builderCodeId` is the app's on-chain BuilderCode id; mints carrying it are
 * the Skew-attributed subset. Owners with no mints in the window are omitted.
 */
export function aggregateV2Leaderboard(
  ordersByMarket: Map<string, V2OrderEvent[]>,
  builderCodeId: string | undefined,
  nowMs: number,
): V2LeaderboardRow[] {
  const all: V2OrderEvent[] = [];
  for (const orders of ordersByMarket.values()) all.push(...orders);
  const state = emptyLbState();
  foldOrderEvents(state, all, builderCodeId);
  return finalizeRows(state, builderCodeId, nowMs, 'all');
}
