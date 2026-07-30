'use client';

/**
 * useMarketEvents — today's market-moving calendar from `/api/insights/events`
 * (Clawby `calendar_economic_data` + a news headline, fetched server-side +
 * cached 20 min). Feeds Kelly's "what's happening today?" answer and the greeting
 * heads-up. The browser never touches Clawby directly (key + rate limits live
 * server-side). Pass `{ enabled: false }` to stay dark.
 *
 * Polls slowly (20 min) once healthy: a calendar barely changes intraday, so this
 * adds negligible fetch load. But a transient miss (the route degrading to
 * `available:false` on a cold Clawby hiccup) must NOT get cached for the full 20
 * min — otherwise Kelly reads "no events today" for the whole window. So while the
 * feed is unavailable, it retries every minute until it comes good.
 */
import { useQuery } from '@tanstack/react-query';
import type { EventsFeed } from '@/lib/insights/events';

export type { EventsFeed };

const HEALTHY_MS = 1_200_000; // 20 min once we have a real feed
const RETRY_MS = 60_000; // 1 min while it's unavailable, so a transient miss self-heals

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
    // Treat an unavailable feed as stale so a remount refetches instead of serving
    // the cached miss; poll fast until it's healthy, then back off to 20 min.
    staleTime: (query) => (query.state.data?.available ? HEALTHY_MS : 0),
    refetchInterval: (query) => (query.state.data?.available ? HEALTHY_MS : RETRY_MS),
    refetchOnWindowFocus: false,
  });
  return { data: q.data, loading: q.isLoading };
}
