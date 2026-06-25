/**
 * lib/analytics/flow.ts — the global order-flow fold (Analytics Phase 1).
 *
 * Turns the protocol's public mint/redeem event streams into:
 *   1. a single, normalized, newest-first FlowEvent[] (the Live Flow Tape), and
 *   2. UP-vs-DOWN dollar SENTIMENT, protocol-wide and per market.
 *
 * Pure + server-data-only (mirrors lib/leaderboard/aggregate.ts): no React, no
 * wallet, fully derivable from `/positions/minted` + `/positions/redeemed`, so
 * it runs in queryFns, Server Components, and tests alike.
 *
 * SCALING: event amounts arrive @6dec (de-scale with `fromQuote`), prices and
 * strikes @1e9 (`toFloat`). Timestamps are ms epoch. De-scale HERE, never
 * downstream — the rest of the analytics layer works in plain floats.
 */
import { fromQuote, toFloat } from '@/config/scale';
import type { PositionMintedEvent, PositionRedeemedEvent } from '@/lib/api/types';

export type FlowKind = 'mint' | 'redeem';

/** One normalized line on the flow tape — a single bet placed or cashed out. */
export interface FlowEvent {
  /** Stable, unique id (event digest + index) for React keys + de-dupe. */
  id: string;
  kind: FlowKind;
  /** ms epoch — when it hit chain. */
  ts: number;
  /** The trader: minted.trader, or the credited owner on a redeem. */
  trader: string;
  oracleId: string;
  underlying: string; // "BTC"
  expiry: number; // ms epoch
  strike: number; // float (USD)
  isUp: boolean;
  /** Contracts traded (each pays at most $1). */
  quantity: number;
  /** DUSDC moved: cost paid on a mint, payout received on a redeem. */
  amount: number;
  /** Per-unit price in [0,1]: ask on a mint, bid on a redeem. */
  price: number;
  /** Redeems only — settled (won/expired) vs an early close. */
  settled?: boolean;
}

const idOf = (e: { event_digest: string; event_index: number }) =>
  `${e.event_digest}:${e.event_index}`;

/** Event timestamp (ms). The live position events populate
 *  `checkpoint_timestamp_ms` (what the leaderboard fold uses); `onchain_timestamp`
 *  is absent on these rows, so reading it directly yields NaN. Prefer the
 *  checkpoint time, fall back to onchain time if a future schema adds it. */
const tsOf = (e: { checkpoint_timestamp_ms?: number; onchain_timestamp?: number }) =>
  e.checkpoint_timestamp_ms || e.onchain_timestamp || 0;

const normUnderlying = (u: string | undefined) => u || 'BTC';

/** Normalize a raw minted event into a FlowEvent. */
export function fromMinted(e: PositionMintedEvent): FlowEvent {
  return {
    id: idOf(e),
    kind: 'mint',
    ts: tsOf(e),
    trader: e.trader,
    oracleId: e.oracle_id,
    underlying: normUnderlying((e as { underlying_asset?: string }).underlying_asset),
    expiry: e.expiry,
    strike: toFloat(e.strike),
    isUp: e.is_up,
    quantity: fromQuote(e.quantity),
    amount: fromQuote(e.cost),
    price: toFloat(e.ask_price),
  };
}

/** Normalize a raw redeemed event into a FlowEvent. */
export function fromRedeemed(e: PositionRedeemedEvent): FlowEvent {
  return {
    id: idOf(e),
    kind: 'redeem',
    ts: tsOf(e),
    trader: e.owner,
    oracleId: e.oracle_id,
    underlying: normUnderlying((e as { underlying_asset?: string }).underlying_asset),
    expiry: e.expiry,
    strike: toFloat(e.strike),
    isUp: e.is_up,
    quantity: fromQuote(e.quantity),
    amount: fromQuote(e.payout),
    price: toFloat(e.bid_price),
    settled: e.is_settled,
  };
}

/**
 * Merge both raw streams into one newest-first tape, de-duped by event id.
 * `limit` caps the returned rows (the tape only ever shows a window).
 */
export function buildFlowTape(
  minted: PositionMintedEvent[],
  redeemed: PositionRedeemedEvent[],
  limit = 60,
): FlowEvent[] {
  const seen = new Set<string>();
  const out: FlowEvent[] = [];
  const push = (f: FlowEvent) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    out.push(f);
  };
  for (const e of minted) push(fromMinted(e));
  for (const e of redeemed) push(fromRedeemed(e));
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

/* ----------------------------- sentiment ------------------------------ */

/** UP-vs-DOWN dollar imbalance over a set of MINTS (bets being placed). */
export interface Sentiment {
  /** DUSDC staked on UP. */
  upCost: number;
  /** DUSDC staked on DOWN. */
  downCost: number;
  upCount: number;
  downCount: number;
  /** upCost / (upCost + downCost), in [0,1]. 0.5 when no flow. */
  upShare: number;
  /** Total DUSDC staked across both sides. */
  totalCost: number;
}

const EMPTY_SENTIMENT: Sentiment = {
  upCost: 0,
  downCost: 0,
  upCount: 0,
  downCount: 0,
  upShare: 0.5,
  totalCost: 0,
};

function finishSentiment(up: number, down: number, upN: number, downN: number): Sentiment {
  const total = up + down;
  return {
    upCost: up,
    downCost: down,
    upCount: upN,
    downCount: downN,
    upShare: total > 0 ? up / total : 0.5,
    totalCost: total,
  };
}

/**
 * Protocol-wide sentiment from mints in a time window. `sinceMs` (optional)
 * counts only bets newer than that instant — pass `Date.now() - 3_600_000` for
 * a rolling 1h read; omit for all-time over the supplied window.
 */
export function aggregateSentiment(
  minted: PositionMintedEvent[],
  sinceMs = 0,
): Sentiment {
  let up = 0;
  let down = 0;
  let upN = 0;
  let downN = 0;
  for (const e of minted) {
    if (tsOf(e) < sinceMs) continue;
    const c = fromQuote(e.cost);
    if (e.is_up) {
      up += c;
      upN += 1;
    } else {
      down += c;
      downN += 1;
    }
  }
  return finishSentiment(up, down, upN, downN);
}

/** Per-oracle sentiment — the seed for the Phase-2 market heatmap. */
export function sentimentByOracle(
  minted: PositionMintedEvent[],
  sinceMs = 0,
): Map<string, Sentiment> {
  const up = new Map<string, number>();
  const down = new Map<string, number>();
  const upN = new Map<string, number>();
  const downN = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const e of minted) {
    if (tsOf(e) < sinceMs) continue;
    const c = fromQuote(e.cost);
    if (e.is_up) {
      bump(up, e.oracle_id, c);
      bump(upN, e.oracle_id, 1);
    } else {
      bump(down, e.oracle_id, c);
      bump(downN, e.oracle_id, 1);
    }
  }

  const out = new Map<string, Sentiment>();
  const ids = new Set<string>([...up.keys(), ...down.keys()]);
  for (const id of ids) {
    out.set(
      id,
      finishSentiment(up.get(id) ?? 0, down.get(id) ?? 0, upN.get(id) ?? 0, downN.get(id) ?? 0),
    );
  }
  return out;
}

export { EMPTY_SENTIMENT };
