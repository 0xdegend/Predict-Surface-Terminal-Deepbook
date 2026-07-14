/**
 * lib/leaderboard/v2-aggregate.ts — the real Season-2 board, folded from the
 * per-market order feeds (the v2 stand-in for the legacy global mint/redeem
 * streams, which don't exist on the beta indexer).
 *
 * Per owner: DUSDC staked (volume) and trade count from their mints; net realized
 * PnL by joining each redeem to its mint via `position_root_id` (the same payout
 * rules as the Portfolio's deriveV2HistoryFromOrders — settled pays the terminal
 * amount, a live close nets fees, a liquidation pays nothing); liquidity-weighted
 * holding time; and a Skew-attributed slice (bets that carried the app's builder
 * code). Points come from the shared formula so the board and Portfolio agree.
 *
 * Pure + deterministic (pass `nowMs`), so it unit-tests against fixed events.
 */
import { fromQuote } from '@/config/scale';
import { pointsFromInput } from '@/lib/points/score';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { V2LeaderboardRow } from './v2';

const DAY_MS = 86_400_000;
const n = (v: unknown): number => (v == null ? 0 : Number(v));

interface Acc {
  volume: number;
  trades: number;
  realizedCost: number;
  realizedPayout: number;
  dusdcDaysHeld: number;
  skewVolume: number;
  skewTrades: number;
  lastActiveMs: number;
}

/**
 * Fold the fanned-out order feeds into ranked per-owner rows. `builderCodeId` is
 * the app's on-chain BuilderCode id; mints carrying it are the Skew-attributed
 * slice. Owners with no mints in the window are omitted (a redeem whose mint
 * scrolled out has no liquidity to rank on).
 */
export function aggregateV2Leaderboard(
  ordersByMarket: Map<string, V2OrderEvent[]>,
  builderCodeId: string | undefined,
  nowMs: number,
): V2LeaderboardRow[] {
  const all: V2OrderEvent[] = [];
  for (const orders of ordersByMarket.values()) all.push(...orders);

  // Mint per position root — the cost basis a redeem closes against, and the
  // open/closed marker for holding time.
  const mintByRoot = new Map<string, V2OrderEvent>();
  for (const e of all) {
    if (e.kind === 'order_minted' && e.position_root_id != null) mintByRoot.set(String(e.position_root_id), e);
  }
  const redeemedRoots = new Set<string>();

  const acc = new Map<string, Acc>();
  const ensure = (owner: string): Acc => {
    let a = acc.get(owner);
    if (!a) {
      a = { volume: 0, trades: 0, realizedCost: 0, realizedPayout: 0, dusdcDaysHeld: 0, skewVolume: 0, skewTrades: 0, lastActiveMs: 0 };
      acc.set(owner, a);
    }
    return a;
  };

  for (const e of all) {
    const ts = e.checkpoint_timestamp_ms ?? 0;
    if (e.kind === 'order_minted' && e.owner) {
      const a = ensure(e.owner);
      const cost = fromQuote(n(e.net_premium));
      a.volume += cost;
      a.trades += 1;
      if (ts > a.lastActiveMs) a.lastActiveMs = ts;
      if (builderCodeId && e.builder_code_id === builderCodeId) {
        a.skewVolume += cost;
        a.skewTrades += 1;
      }
    } else if (/redeemed/i.test(e.kind ?? '') && e.owner) {
      const a = ensure(e.owner);
      if (ts > a.lastActiveMs) a.lastActiveMs = ts;
      const mint = e.position_root_id != null ? mintByRoot.get(String(e.position_root_id)) : undefined;
      if (e.position_root_id != null) redeemedRoots.add(String(e.position_root_id));

      const settled = /settled/i.test(e.kind ?? '');
      const liquidated = /liquidat/i.test(e.kind ?? '');
      const fees = settled ? 0 : n(e.trading_fee) + n(e.builder_fee) + n(e.penalty_fee);
      const gross = liquidated ? 0 : fromQuote(settled ? n(e.payout_amount) : n(e.redeem_amount));
      const payout = Math.max(0, gross - fromQuote(fees));

      let closedCost = 0;
      let days = 0;
      if (mint) {
        const totalQty = n(mint.quantity) || n(e.quantity_closed);
        const closed = n(e.quantity_closed) || totalQty;
        const frac = totalQty > 0 ? closed / totalQty : 1;
        closedCost = fromQuote(n(mint.net_premium)) * frac;
        days = Math.max(0, (ts - (mint.checkpoint_timestamp_ms ?? ts)) / DAY_MS);
      }
      a.realizedCost += closedCost;
      a.realizedPayout += payout;
      a.dusdcDaysHeld += closedCost * days;
    }
  }

  // Still-open mints (never redeemed in the window) earn holding time to now.
  for (const [root, mint] of mintByRoot) {
    if (redeemedRoots.has(root) || !mint.owner) continue;
    const a = acc.get(mint.owner);
    if (!a) continue;
    const cost = fromQuote(n(mint.net_premium));
    a.dusdcDaysHeld += cost * Math.max(0, (nowMs - (mint.checkpoint_timestamp_ms ?? nowMs)) / DAY_MS);
  }

  const rows: V2LeaderboardRow[] = [];
  for (const [owner, a] of acc) {
    if (a.trades === 0) continue; // redeem-only owner — no in-window liquidity
    const netPnl = a.realizedPayout - a.realizedCost;
    const points = pointsFromInput({ volume: a.volume, netPnl, dusdcDaysHeld: a.dusdcDaysHeld });
    rows.push({
      owner,
      points: points.total,
      volume: a.volume,
      trades: a.trades,
      netPnl,
      skewVolume: a.skewVolume,
      skewTrades: a.skewTrades,
      viaSkew: a.skewTrades > 0,
      lastActiveMs: a.lastActiveMs,
    });
  }

  return rows.sort((x, y) => y.points - x.points || y.volume - x.volume);
}
