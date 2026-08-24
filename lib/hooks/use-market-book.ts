'use client';

/**
 * useMarketBook — our own standing interest on ONE market, live.
 *
 * The Options page's whole edge is that we can read our own book, and until now it
 * read everybody else's instead. This is the smallest thing that fixes that: one
 * market's order feed, folded by `buildMarketBook` into interest by strike, the
 * up/down lean, our own max pain, and the probability the crowd actually paid.
 *
 * Scoped to the SELECTED market rather than fanned out across all of them, unlike
 * `useV2Analytics`. That page answers "what is happening across the venue"; this one
 * answers "what is the crowd doing on the bet I am looking at", and the second
 * question is one request, not thirty.
 *
 * Shares TanStack keys with the analytics fan-out (`qkV2.marketOrders`), so a trader
 * who has both open pays for the feed once.
 */
import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getMarketOrders, qkV2 } from '@/lib/api/v2/client';
import { buildMarketBook, EMPTY_BOOK, type MarketBook } from '@/lib/analytics/market-book';
import { buildFlowHistory, EMPTY_FLOW, type FlowHistory } from '@/lib/analytics/flow-history';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

/** Deep enough to hold a busy short market's whole life; these settle in minutes. */
const ORDERS_LIMIT = 120;
/** The book moves on mints, not on price ticks, so this is a slow poll on purpose. */
const REFETCH_MS = 15_000;

/** The flow chart re-buckets at most this often, however fast `now` ticks. */
const FLOW_QUANTUM_MS = 5_000;

export interface UseMarketBook {
  book: MarketBook;
  /** How that book was built over time, from the same feed. */
  flow: FlowHistory;
  isLoading: boolean;
  /** True once a feed has resolved, even if the market has no bets on it yet. */
  hasData: boolean;
}

/** `now` anchors the flow chart's right edge to the present, so a market that has
 *  gone quiet shows the quiet instead of ending at its last trade. */
export function useMarketBook(market: V2Market | null, now = 0): UseMarketBook {
  const marketId = market?.expiry_market_id ?? null;

  const q = useQuery<V2OrderEvent[]>({
    queryKey: qkV2.marketOrders(marketId ?? 'none'),
    queryFn: () => getMarketOrders(marketId as string, ORDERS_LIMIT),
    enabled: !!marketId,
    refetchInterval: REFETCH_MS,
    // Hold the previous market's book while the new one loads, so switching expiry
    // swaps the numbers instead of blanking the panel and reflowing the page.
    placeholderData: keepPreviousData,
    staleTime: REFETCH_MS,
  });

  const book = useMemo(
    () => (market && q.data ? buildMarketBook(q.data, market.tick_size) : EMPTY_BOOK),
    [q.data, market],
  );

  // Quantized so a 1s page clock cannot re-bucket the whole feed on every tick; the
  // underlying query only refetches every 15s anyway. Never falls back to `Date.now()`:
  // reading the wall clock during render is impure (CLAUDE.md), so an absent clock
  // anchors the chart on the newest event in the feed instead.
  const nowQ = now > 0 ? Math.floor(now / FLOW_QUANTUM_MS) * FLOW_QUANTUM_MS : 0;
  const flow = useMemo(() => {
    if (!q.data) return EMPTY_FLOW;
    const anchor = nowQ > 0 ? nowQ : newestStamp(q.data);
    return anchor > 0 ? buildFlowHistory(q.data, { now: anchor }) : EMPTY_FLOW;
  }, [q.data, nowQ]);

  return { book, flow, isLoading: q.isLoading, hasData: q.isSuccess };
}

/** Newest event timestamp in a feed, or 0. The flow chart's fallback anchor when the
 *  caller has no live clock to pass. */
function newestStamp(orders: V2OrderEvent[]): number {
  let max = 0;
  for (const o of orders) {
    const t = o.checkpoint_timestamp_ms;
    if (typeof t === 'number' && Number.isFinite(t) && t > max) max = t;
  }
  return max;
}
