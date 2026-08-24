/**
 * lib/analytics/flow-history.ts — how the book on one expiry was BUILT, over time.
 *
 * The Options page could say what the crowd's position is right now (market-book.ts)
 * but nothing about how it got there, and those are different reads. A market that
 * drifted to 63% up over an hour and one that flipped there in the last ninety seconds
 * look identical in a snapshot and mean opposite things.
 *
 * WHY THIS IS FOLDED CLIENT-SIDE. The indexer has a bucketing endpoint for exactly
 * this (`/markets/:id/activity`, hourly mint/redeem buckets, typed as
 * `V2ActivityBucket`) and it is the obvious source. It does not work on the live
 * deployment: `getMarketActivity` short-circuits to `[]` whenever `V2_IS_729_PLUS`,
 * because 7-29 onward has no bucketing indexer, and 8-06 is a 7-29-shape republish.
 * Its buckets are also HOURLY, which is the wrong resolution for markets that settle
 * in minutes. So the flow is bucketed here out of the same order-event log the book
 * already reads, at a resolution derived from the market's own lifetime.
 *
 * Mints only. A redeem is someone leaving, which is a real signal but a different one,
 * and mixing the two into a single "activity" bar is how a chart ends up meaning
 * nothing. Redeem counts ride alongside instead.
 *
 * Pure and side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */
import { fromQuote } from '@/config/scale';
import { orderSide } from './v2-aggregate';
import type { V2OrderEvent } from '@/lib/api/v2/types';

/** How the newest bucket compares with the run rate before it. */
export type FlowTrend = 'building' | 'steady' | 'fading';

export interface FlowBucket {
  /** Bucket start (ms epoch). */
  startMs: number;
  /** Premium staked in this bucket (DUSDC). */
  stakeUsd: number;
  upStakeUsd: number;
  downStakeUsd: number;
  /** Range mints, which have no direction. */
  rangeStakeUsd: number;
  bets: number;
}

export interface FlowHistory {
  /** Oldest first, evenly spaced, with empty buckets present so gaps read as gaps. */
  buckets: FlowBucket[];
  bucketMs: number;
  /** Total premium minted across the window (DUSDC). */
  stakeUsd: number;
  bets: number;
  /** Distinct owners who minted across the whole window. */
  traders: number;
  /** Largest bucket's stake, for bar scaling. 0 with no flow. */
  peakUsd: number;
  /** Busiest bucket, or null with no flow. */
  busiest: FlowBucket | null;
  /** Newest bucket vs the mean of the rest. Null with too little history to judge. */
  trend: FlowTrend | null;
  /** Mints that have since been closed or settled out, for context. */
  redeems: number;
}

/** A bucket is "building"/"fading" only past this much difference from the run rate. */
const TREND_BAND = 0.35;
/** Below this many populated buckets, a trend is noise. */
const MIN_BUCKETS_FOR_TREND = 3;
/** Buckets we aim to draw. Enough to show a shape, few enough to stay legible. */
export const TARGET_BUCKETS = 16;

/** A round bucket size that splits `spanMs` into roughly `TARGET_BUCKETS` bars. */
export function flowBucketMs(spanMs: number): number {
  const S = 1_000;
  const steps = [5 * S, 15 * S, 30 * S, 60 * S, 2 * 60 * S, 5 * 60 * S, 15 * 60 * S, 30 * 60 * S, 60 * 60 * S, 4 * 60 * 60 * S, 12 * 60 * 60 * S];
  const ideal = Math.max(1, spanMs) / TARGET_BUCKETS;
  return steps.find((s) => s >= ideal) ?? steps[steps.length - 1];
}

const emptyBucket = (startMs: number): FlowBucket => ({
  startMs,
  stakeUsd: 0,
  upStakeUsd: 0,
  downStakeUsd: 0,
  rangeStakeUsd: 0,
  bets: 0,
});

export const EMPTY_FLOW: FlowHistory = {
  buckets: [],
  bucketMs: 0,
  stakeUsd: 0,
  bets: 0,
  traders: 0,
  peakUsd: 0,
  busiest: null,
  trend: null,
  redeems: 0,
};

/**
 * Bucket one market's order log into a flow history.
 *
 * `now` anchors the newest bucket so the chart's right edge is the present rather than
 * the last trade, which matters: a market that has gone quiet should show the quiet.
 * `bucketMs` defaults to a size derived from the span actually covered by the orders.
 */
export function buildFlowHistory(
  orders: V2OrderEvent[],
  opts: { now: number; bucketMs?: number; sinceMs?: number } ,
): FlowHistory {
  const { now } = opts;
  const mints = orders.filter((o) => o.kind === 'order_minted' && Number.isFinite(o.checkpoint_timestamp_ms));
  const redeems = orders.length - mints.length;
  if (mints.length === 0) return { ...EMPTY_FLOW, redeems };

  const stamps = mints.map((o) => o.checkpoint_timestamp_ms as number);
  const firstMs = opts.sinceMs ?? Math.min(...stamps);
  const bucketMs = opts.bucketMs ?? flowBucketMs(Math.max(now - firstMs, 1));

  // Anchor the grid to `now` so the last bucket ends at the present, then walk back.
  const lastStart = Math.floor(now / bucketMs) * bucketMs;
  const firstStart = Math.floor(firstMs / bucketMs) * bucketMs;
  const count = Math.max(1, Math.min(TARGET_BUCKETS * 4, Math.floor((lastStart - firstStart) / bucketMs) + 1));
  const startAt = lastStart - (count - 1) * bucketMs;

  const buckets: FlowBucket[] = [];
  for (let i = 0; i < count; i++) buckets.push(emptyBucket(startAt + i * bucketMs));

  const traders = new Set<string>();
  let stakeUsd = 0;
  let bets = 0;

  for (const o of mints) {
    const ts = o.checkpoint_timestamp_ms as number;
    const idx = Math.floor((ts - startAt) / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    const stake = fromQuote((o.net_premium ?? 0) as string | number);
    if (!(stake > 0)) continue;
    const b = buckets[idx];
    const side = orderSide(o.lower_tick, o.higher_tick);
    b.stakeUsd += stake;
    b.bets += 1;
    if (side === 'up') b.upStakeUsd += stake;
    else if (side === 'down') b.downStakeUsd += stake;
    else b.rangeStakeUsd += stake;
    stakeUsd += stake;
    bets += 1;
    if (typeof o.owner === 'string' && o.owner) traders.add(o.owner);
  }

  const peakUsd = buckets.reduce((m, b) => Math.max(m, b.stakeUsd), 0);
  const busiest = peakUsd > 0 ? buckets.reduce((a, b) => (b.stakeUsd > a.stakeUsd ? b : a)) : null;

  return {
    buckets,
    bucketMs,
    stakeUsd,
    bets,
    traders: traders.size,
    peakUsd,
    busiest,
    trend: trendOf(buckets),
    redeems,
  };
}

/**
 * The newest bucket against the average of the ones before it. Deliberately blunt:
 * this labels a bar chart, it is not a signal, and it stays null rather than reading a
 * trend out of two data points.
 */
export function trendOf(buckets: FlowBucket[]): FlowTrend | null {
  if (buckets.length < MIN_BUCKETS_FOR_TREND) return null;
  const last = buckets[buckets.length - 1];
  const prior = buckets.slice(0, -1);
  const populated = prior.filter((b) => b.stakeUsd > 0).length;
  if (populated < MIN_BUCKETS_FOR_TREND - 1) return null;
  const mean = prior.reduce((s, b) => s + b.stakeUsd, 0) / prior.length;
  if (!(mean > 0)) return last.stakeUsd > 0 ? 'building' : null;
  const ratio = last.stakeUsd / mean;
  if (ratio >= 1 + TREND_BAND) return 'building';
  if (ratio <= 1 - TREND_BAND) return 'fading';
  return 'steady';
}
