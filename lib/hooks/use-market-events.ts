'use client';

/**
 * useMarketEvents — today's market-moving calendar from `/api/insights/events`
 * (Clawby `calendar_economic_data` + a news headline, fetched server-side +
 * cached 20 min). Feeds Kelly's "what's happening today?" answer and the greeting
 * heads-up. The browser never touches Clawby directly (key + rate limits live
 * server-side). Pass `{ enabled: false }` to stay dark.
 *
 * Polls slowly (20 min): a calendar barely changes intraday, so this adds
 * negligible fetch load.
 */
import { useQuery } from '@tanstack/react-query';
import type { EventsFeed } from '@/lib/insights/events';

export type { EventsFeed };

export function useMarketEvents(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const q = useQuery<EventsFeed>({
    queryKey: ['insights', 'market-events'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/insights/events', { signal });
      if (!res.ok) throw new Error(`events ${res.status}`);
      return (await res.json()) as EventsFeed;
    },
    enabled,
    staleTime: 1_200_000,
    refetchInterval: 1_200_000,
    refetchOnWindowFocus: false,
  });
  return { data: q.data, loading: q.isLoading };
}
