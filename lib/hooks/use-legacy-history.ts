'use client';

/**
 * useLegacyHistoryByOwner — the full carried-over trade history keyed by wallet.
 *
 * Admin-only. The snapshots are large and grow with every release, so they are served from
 * /api/v2/legacy-history rather than bundled; this hook wraps that read so the two admin
 * views share one cached query instead of fetching a megabyte twice.
 *
 * Returns `{}` while loading or if the read fails, which is the same shape the callers
 * already handle: the stats degrade to live-only rather than breaking the console.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchLegacyHistoryByOwner } from '@/lib/portfolio/legacy-history';
import type { PastPrediction } from '@/lib/portfolio/history';

const EMPTY: Record<string, PastPrediction[]> = {};

export function useLegacyHistoryByOwner(): Record<string, PastPrediction[]> {
  const q = useQuery<Record<string, PastPrediction[]>>({
    queryKey: ['v2', 'legacy-history', 'all'],
    queryFn: ({ signal }) => fetchLegacyHistoryByOwner(signal),
    // A static snapshot compiled into the server bundle: it cannot change between renders.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return q.data ?? EMPTY;
}
