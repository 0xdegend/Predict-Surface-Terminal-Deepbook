/**
 * lib/analytics/v2-aggregate.ts — REAL analytics for the v2 Analytics page.
 *
 * There is no global flow endpoint on the beta indexer, but every per-market
 * feed is real: `/markets/:id/orders` (mint/redeem EVENTS — trader, direction,
 * stake, leverage, odds, time) and `/markets/:id/activity` (hourly mint/redeem
 * rollups). This module fans those out across the active markets and folds them
 * into the shapes the Analytics tools render — replacing the old seeded sample
 * data. Pure + deterministic, so it unit-tests against fixed events.
 *
 * Direction / IV notes:
 *  - side comes from the tick pair: higher = +∞ → UP, lower = 0 → DOWN, else RANGE.
 *  - ATM implied vol ("price swing") is NOT in the feed — it's computed from the
 *    live pricer in the hook and passed in, so this module stays feed-only.
 */
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import { fromQuote, toFloat } from '@/config/scale';
import { cadenceOf, type V2Cadence } from '@/lib/markets/v2-discovery';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

export type Side = 'up' | 'down' | 'range';

/** Direction from the tick pair. Mirrors lib/portfolio/v2's tickDirection. */
export function orderSide(lowerTick: unknown, higherTick: unknown): Side {
  const hi = higherTick != null ? BigInt(higherTick as string | number) : 0n;
  const lo = lowerTick != null ? BigInt(lowerTick as string | number) : 0n;
  if (hi === POS_INF_TICK) return 'up';
  if (lo === 0n && hi !== 0n) return 'down';
  return 'range';
}

const isMint = (o: V2OrderEvent) => o.kind === 'order_minted';

/* --------------------------------- flow ----------------------------------- */

export interface FlowRow {
  id: string;
  tsMs: number;
  trader: string;
  cadence: V2Cadence;
  side: Side;
  /** Premium staked (DUSDC). */
  stakeUsd: number;
  /** Max payout / notional (DUSDC). */
  payoutUsd: number;
  leverage: number;
}

/** One minted order → a flow row (null for non-mints / rows missing an owner). */
export function flowRowFromOrder(o: V2OrderEvent, cadence: V2Cadence): FlowRow | null {
  if (!isMint(o) || !o.owner) return null;
  return {
    id: String(o.order_id ?? `${o.expiry_market_id ?? 'm'}-${o.checkpoint_timestamp_ms ?? 0}`),
    tsMs: o.checkpoint_timestamp_ms ?? 0,
    trader: o.owner,
    cadence,
    side: orderSide(o.lower_tick, o.higher_tick),
    stakeUsd: fromQuote(Number(o.net_premium ?? 0)),
    payoutUsd: fromQuote(Number(o.quantity ?? 0)),
    leverage: o.leverage != null ? toFloat(o.leverage) : 1,
  };
}

/**
 * Every minted order across the active markets → flow rows, newest first. Each
 * market's cadence tags its rows (the row can't carry it otherwise).
 */
export function flowRows(
  ordersByMarket: Map<string, V2OrderEvent[]>,
  markets: V2Market[],
): FlowRow[] {
  const cadenceById = new Map(markets.map((m) => [m.expiry_market_id, cadenceOf(m)]));
  const rows: FlowRow[] = [];
  for (const [id, orders] of ordersByMarket) {
    const cadence = cadenceById.get(id) ?? '1m';
    for (const o of orders) {
      const row = flowRowFromOrder(o, cadence);
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => b.tsMs - a.tsMs);
}

/* ------------------------------- sentiment -------------------------------- */

export interface Sentiment {
  upCost: number;
  downCost: number;
  upCount: number;
  downCount: number;
  /** upCost / (upCost + downCost); 0.5 when there's no directional flow. */
  upShare: number;
  /** upCost + downCost (RANGE bets are directionally neutral, excluded). */
  totalCost: number;
}

/** UP-vs-DOWN lean over minted orders, weighted by premium staked. */
export function sentimentFromOrders(orders: Iterable<V2OrderEvent>): Sentiment {
  let upCost = 0;
  let downCost = 0;
  let upCount = 0;
  let downCount = 0;
  for (const o of orders) {
    if (!isMint(o)) continue;
    const side = orderSide(o.lower_tick, o.higher_tick);
    if (side === 'range') continue;
    const cost = fromQuote(Number(o.net_premium ?? 0));
    if (side === 'up') {
      upCost += cost;
      upCount += 1;
    } else {
      downCost += cost;
      downCount += 1;
    }
  }
  const totalCost = upCost + downCost;
  return {
    upCost,
    downCost,
    upCount,
    downCount,
    upShare: totalCost > 0 ? upCost / totalCost : 0.5,
    totalCost,
  };
}

/* ------------------------------ market cells ------------------------------ */

/** A per-market analytics row: real market + real metrics from its feeds. */
export interface MarketCell {
  market: V2Market;
  marketId: string;
  cadence: V2Cadence;
  expiry: number;
  /** Live forward (≈ spot) from the pricer; falls back to the passed spot. */
  forward: number;
  /** ATM implied vol (expected swing), computed from the pricer in the hook. */
  atmIv: number;
  /** Premium staked over the activity window (DUSDC). */
  volume: number;
  /** Open bets right now (open order count). */
  oi: number;
  /** Mints over the activity window. */
  bets: number;
  /** Crowd lean 0..1 from this market's recent directional flow. */
  upShare: number;
}

/**
 * Sum minted premium + count from a market's ORDER events (DUSDC / count).
 *
 * The orders feed is the same fast source that powers the flow tape and the
 * biggest-bet stat, so a bet lands in volume the instant it appears in "Latest
 * bets". The bucketed `/activity` rollups we used before lagged behind orders
 * AND stopped at market expiry, so a live bet read as $0 volume until (if ever)
 * the bucket caught up — which is exactly the mismatch this replaces.
 */
export function marketVolumeFromOrders(orders: V2OrderEvent[] | undefined): { volume: number; bets: number } {
  if (!orders) return { volume: 0, bets: 0 };
  let volume = 0;
  let bets = 0;
  for (const o of orders) {
    if (!isMint(o)) continue;
    volume += fromQuote(Number(o.net_premium ?? 0));
    bets += 1;
  }
  return { volume, bets };
}

export interface MarketInputs {
  orders?: V2OrderEvent[];
  oi?: number;
  forward?: number | null;
  atmIv?: number | null;
}

/** Assemble one market's cell from its feeds. `spot` is the page-wide fallback forward. */
export function marketCell(market: V2Market, input: MarketInputs, spot: number | null): MarketCell {
  const { volume, bets } = marketVolumeFromOrders(input.orders);
  const { upShare } = sentimentFromOrders(input.orders ?? []);
  return {
    market,
    marketId: market.expiry_market_id,
    cadence: cadenceOf(market),
    expiry: market.expiry,
    forward: input.forward ?? spot ?? 0,
    atmIv: input.atmIv ?? 0,
    volume,
    oi: input.oi ?? 0,
    bets,
    upShare,
  };
}

/** The metric that drives the Markets treemap/table (size ∝ value). */
export type GridMetric = 'volume' | 'oi' | 'iv' | 'sentiment';

/** A cell's value under the chosen metric (sentiment = distance from a coin-flip). */
export function metricValue(c: MarketCell, m: GridMetric): number {
  return m === 'volume' ? c.volume : m === 'oi' ? c.oi : m === 'iv' ? c.atmIv : Math.abs(c.upShare - 0.5);
}

/** All cells, ranked by volume desc (the tools re-sort per selected metric). */
export function marketCells(
  markets: V2Market[],
  inputs: Map<string, MarketInputs>,
  spot: number | null,
): MarketCell[] {
  return markets
    .map((m) => marketCell(m, inputs.get(m.expiry_market_id) ?? {}, spot))
    .sort((a, b) => b.volume - a.volume);
}

/* --------------------------------- KPIs ----------------------------------- */

export interface Kpis {
  /** Premium staked across all markets over the activity window (DUSDC). */
  totalBet: number;
  activeMarkets: number;
  /** Cost-weighted UP share across all recent directional flow. */
  upShare: number;
  /** Largest single stake seen in the recent flow (DUSDC). */
  biggestBet: number;
}

/**
 * Top-line reads, all from the pooled recent orders — the SAME feed as the flow
 * tape — so the strip, the "Latest bets" list, and the sentiment gauge can never
 * disagree: a bet counts in total volume the instant it shows in the tape.
 * `activeMarkets` is the live-market count, passed in (the order pool spans a
 * wider recent window, so it isn't the market count).
 */
export function kpisFromData(allOrders: Iterable<V2OrderEvent>, activeMarkets: number): Kpis {
  let totalBet = 0;
  let biggestBet = 0;
  const orderList: V2OrderEvent[] = [];
  for (const o of allOrders) {
    orderList.push(o);
    if (isMint(o)) {
      const stake = fromQuote(Number(o.net_premium ?? 0));
      totalBet += stake;
      biggestBet = Math.max(biggestBet, stake);
    }
  }
  return {
    totalBet,
    activeMarkets,
    upShare: sentimentFromOrders(orderList).upShare,
    biggestBet,
  };
}
