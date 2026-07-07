'use client';

/**
 * useV2Markets — keep the active-markets list LIVE after the server snapshot.
 *
 * The /v2 page server-fetches active markets once for instant first paint, but
 * the short cadences roll fast (a fresh 1-minute market opens every minute), so
 * a static list goes stale in seconds: new markets only appeared on reload and
 * the table could sit empty once everything expired. This hook polls /markets
 * and re-derives the active set, seeded from the server snapshot (initialData)
 * so there's no refetch flash on mount.
 *
 * Poll beats event-push here: MarketCreated rows come from the indexer anyway,
 * and 10s is far inside a 1-minute cadence. Expiry-side freshness is already
 * handled downstream (pickers filter `expiry > now` per tick); this hook covers
 * the creation side.
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getV2Markets, qkV2 } from '@/lib/api/v2/client';
import { activeMarkets } from '@/lib/markets/v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';

const POLL_MS = 10_000;

export function useV2Markets(initial: V2Market[]): V2Market[] {
  const { data } = useQuery({
    queryKey: qkV2.markets,
    queryFn: async () => activeMarkets(await getV2Markets(100)),
    initialData: initial,
    refetchInterval: POLL_MS,
    // Keep the last good list on a transient server hiccup rather than
    // blanking the table (initialData already guarantees data is never
    // undefined, but a failed refetch shouldn't clear it either).
    placeholderData: keepPreviousData,
    retry: 1,
  });
  return data ?? initial;
}
