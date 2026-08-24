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
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

/** Deep enough to hold a busy short market's whole life; these settle in minutes. */
const ORDERS_LIMIT = 120;
/** The book moves on mints, not on price ticks, so this is a slow poll on purpose. */
const REFETCH_MS = 15_000;

export interface UseMarketBook {
  book: MarketBook;
  isLoading: boolean;
  /** True once a feed has resolved, even if the market has no bets on it yet. */
  hasData: boolean;
}

export function useMarketBook(market: V2Market | null): UseMarketBook {
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

  return { book, isLoading: q.isLoading, hasData: q.isSuccess };
}
