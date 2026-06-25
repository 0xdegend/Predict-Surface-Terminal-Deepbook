'use client';

/**
 * useTraderStyle — classify one trader from their full position history.
 *
 * Fans out the trader's managers over `/positions/summary` (all positions, not
 * just open) + `/ranges` (for the range-volume signal). Reuses the SAME query
 * keys as the profile's open-positions list, so on a profile this shares the
 * cache and adds no extra network cost. Server-data only — no wallet.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getManagerPositions, getManagerRanges, qk } from '@/lib/api/client';
import { fromQuote } from '@/config/scale';
import { classifyStyle, type TraderStyle } from '@/lib/analytics/trader-style';
import type { PositionSummary } from '@/lib/api/types';

export interface UseTraderStyle {
  style: TraderStyle | null;
  loading: boolean;
}

export function useTraderStyle(managerIds: string[], enabled = true): UseTraderStyle {
  const ids = useMemo(() => [...new Set(managerIds)], [managerIds]);

  const posQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.managerPositions(id),
      queryFn: () => getManagerPositions(id),
      enabled: enabled && !!id,
      staleTime: 5000,
    })),
  });
  const rangeQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.managerRanges(id),
      queryFn: () => getManagerRanges(id),
      enabled: enabled && !!id,
      staleTime: 5000,
    })),
  });

  const posStamps = posQs.map((q) => q.dataUpdatedAt).join(',');
  const rangeStamps = rangeQs.map((q) => q.dataUpdatedAt).join(',');

  const style = useMemo(() => {
    if (ids.length === 0) return null;
    const positions: PositionSummary[] = posQs.flatMap((q) => q.data ?? []);
    const rangeVolume = rangeQs
      .flatMap((q) => q.data?.minted ?? [])
      .reduce((sum, m) => sum + fromQuote(m.cost), 0);
    return classifyStyle(positions, rangeVolume);
    // Recompute when any underlying query settles (stamps) or the id set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posStamps, rangeStamps, ids.length]);

  const loading = posQs.some((q) => q.isLoading) || rangeQs.some((q) => q.isLoading);
  return { style, loading };
}
