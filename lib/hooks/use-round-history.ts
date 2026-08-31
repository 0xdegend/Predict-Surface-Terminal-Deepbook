'use client';

/**
 * use-round-history — the last few FINISHED rounds of a cadence, resolved to up/down.
 *
 * Feeds simple mode's results tape. Two things about the live data shape it: proven
 * against the chain in [[lib/markets/round-history.live.test]].
 *
 * 1. The markets list is a walk of `MarketCreated` events capped at 50 rows, which at
 *    the current pace is ~38 finished 1-minute rounds, ~6 five-minute, and ZERO hourly
 *    (the protocol keeps only one hourly market alive at a time). So the hourly tab has
 *    no history of its own and never will. Rather than showing an empty box there, this
 *    falls back to the densest cadence that does have history and REPORTS which one it
 *    returned, so the tape can label itself honestly instead of implying the marks
 *    belong to the round on screen.
 *
 * 2. Settlement is terminal. Once a round's state carries a settlement price it can
 *    never change, so those queries stop polling entirely — otherwise a ten-round tape
 *    would re-read ten finished markets forever for an answer that is already final.
 *
 * The list itself polls slowly (a round finishes every 60s at the very fastest), which
 * also keeps this off the 4s active-markets walk the pickers depend on.
 */
import { useMemo } from 'react';
import { useQueries, useQuery, keepPreviousData, type Query } from '@tanstack/react-query';
import { getV2Markets, getV2MarketState, qkV2 } from '@/lib/api/v2/client';
import { recentMarkets } from '@/lib/markets/v2-discovery';
import type { SimpleCadence } from '@/lib/markets/round-pick';
import { pickHistoryRounds, settledOutcome, type RoundOutcome } from '@/lib/markets/round-history';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';

/** How far back to look for finished rounds. Comfortably past the 50-row event cap at
 *  1-minute pace, so the cap is what bounds the window rather than this. */
const LOOKBACK_MS = 3 * 60 * 60_000;

export interface RoundHistory {
  /** The cadence the outcomes actually came from — NOT necessarily the one asked for. */
  cadence: SimpleCadence;
  /** Oldest first, so the tape reads left to right like time. */
  outcomes: RoundOutcome[];
  /** True while the first fetch is in flight (the tape holds its space rather than popping in). */
  loading: boolean;
}

export function useRoundHistory(cadence: SimpleCadence, now: number, count = 10): RoundHistory {
  const listQ = useQuery({
    // Its own key: the pickers' active-only list has already dropped these markets.
    queryKey: [...qkV2.markets, 'history'] as const,
    queryFn: () => getV2Markets(200),
    refetchInterval: 30_000,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  // Which rounds to resolve. Pure and shared with the tests, including the live one —
  // see [[lib/markets/round-history]] for why the cadence asked for isn't always the
  // cadence returned.
  const { picked, from } = useMemo(
    () => pickHistoryRounds(recentMarkets(listQ.data ?? [], LOOKBACK_MS, now), cadence, now, count),
    [listQ.data, cadence, now, count],
  );

  // `combine` rather than a useMemo over the results: it folds inside the query cache,
  // where structural sharing keeps the returned array reference stable while the data
  // is unchanged — so a tape of ten finished rounds doesn't re-render on every tick of
  // the screen's clock.
  const outcomes = useQueries({
    queries: picked.map((m: V2Market) => ({
      queryKey: qkV2.marketState(m.expiry_market_id),
      queryFn: () => getV2MarketState(m.expiry_market_id),
      // Settled is forever: stop asking the moment the answer lands.
      refetchInterval: (q: Query<V2MarketState>) => (q.state.data?.settlement ? false : 20_000),
      staleTime: 20_000,
    })),
    combine: (results) => {
      const out: RoundOutcome[] = [];
      picked.forEach((m, i) => {
        const o = settledOutcome(m, results[i]?.data ?? null);
        if (o) out.push(o);
      });
      // `picked` is newest-first (market discovery order); the tape reads like time.
      return out.sort((a, b) => a.expiry - b.expiry);
    },
  });

  return { cadence: from, outcomes, loading: listQ.isLoading };
}
