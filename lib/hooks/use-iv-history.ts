'use client';

/**
 * useIvHistory — the accumulating constant-maturity ATM implied-vol series, plus
 * today's reading ranked against it.
 *
 * The route both takes the sample and serves the history (see
 * app/api/v2/iv-history/route.ts), so this is one request rather than a read plus a
 * write. It is polled slowly on purpose: the store only records a sample every four
 * minutes, so anything faster would just be re-fetching the same array.
 *
 * `rank` is null until the series is long enough to mean something, and the UI is
 * expected to say so rather than drawing a percentile from six readings.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ivRank, type IvRank, type IvSample } from '@/lib/insights/iv-history';
import type { IvHistoryResponse } from '@/app/api/v2/iv-history/route';

/** Matches the store's sampling interval; a faster poll returns the same series. */
const REFETCH_MS = 4 * 60_000;

export interface UseIvHistory {
  samples: IvSample[];
  /** The reading taken on the last fetch, or null when the chain read failed. */
  current: number | null;
  /** Where `current` sits in the history. Null until there is enough of it. */
  rank: IvRank | null;
  tenorHours: number;
  isLoading: boolean;
}

export function useIvHistory(enabled = true): UseIvHistory {
  const q = useQuery<IvHistoryResponse>({
    queryKey: ['v2', 'iv-history'],
    queryFn: async () => {
      const r = await fetch('/api/v2/iv-history');
      if (!r.ok) throw new Error(`iv-history ${r.status}`);
      return (await r.json()) as IvHistoryResponse;
    },
    enabled,
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
  });

  // Derived from `q.data` itself, not from a `?? []` expression: a fresh array
  // literal each render would re-run the memo every time.
  const samples = useMemo(() => q.data?.samples ?? [], [q.data]);
  const current = q.data?.current ?? null;
  const rank = useMemo(() => (current != null ? ivRank(samples, current) : null), [samples, current]);

  return {
    samples,
    current,
    rank,
    tenorHours: q.data?.tenorHours ?? 1,
    isLoading: q.isLoading,
  };
}
