'use client';

/**
 * useV2TraderStylesRoster — the Analytics "Trader styles" roster, from
 * `/api/v2/trader-styles`. That route serves the accumulating style indexer, which
 * classifies every trader from their COMPLETE all-time betting history (not a
 * windowed fan-out) and is cached server-side — so the browser makes ONE request
 * and the roster is complete, not just the last few hours the flow tape shows.
 *
 * Pass `{ enabled: false }` (e.g. until the tab is opened) to skip the scan.
 */
import { useQuery } from '@tanstack/react-query';
import type { V2TraderStyles } from '@/lib/analytics/v2-trader-style';

/** The route's JSON: the classified roster plus an availability flag. */
type RosterResponse = V2TraderStyles & { available?: boolean; asOf?: number };

/** Mirror the route's cache TTL — the roster changes slowly. */
const TTL_MS = 120_000;
const EMPTY: V2TraderStyles = { traders: [], distribution: [], total: 0 };

export function useV2TraderStylesRoster(opts?: { enabled?: boolean }): { styles: V2TraderStyles; loading: boolean } {
  const enabled = opts?.enabled ?? true;
  const q = useQuery<RosterResponse>({
    queryKey: ['v2', 'trader-styles-roster'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/v2/trader-styles', { signal });
      if (!res.ok) throw new Error(`trader-styles ${res.status}`);
      return (await res.json()) as RosterResponse;
    },
    enabled,
    staleTime: TTL_MS,
    refetchInterval: TTL_MS,
    refetchOnWindowFocus: false,
  });

  const styles: V2TraderStyles = q.data
    ? { traders: q.data.traders, distribution: q.data.distribution, total: q.data.total }
    : EMPTY;
  return { styles, loading: enabled && q.isLoading };
}
