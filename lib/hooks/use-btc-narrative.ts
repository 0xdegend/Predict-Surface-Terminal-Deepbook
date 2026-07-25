'use client';

/**
 * useBtcNarrative — the "what is X talking about?" chatter aggregate from
 * `/api/insights/btc/narrative` (Clawby PRO x_search, fetched server-side + cached
 * 5 min). Feeds the co-pilot's "why is BTC moving?" answer. The browser never
 * touches Clawby directly (key + rate limits live server-side). Pass
 * `{ enabled: false }` to stay dark.
 *
 * Polls slowly (5 min) on purpose: chatter shifts over hours, not seconds, and
 * x_search is the heaviest Clawby call — so this adds negligible fetch load.
 */
import { useQuery } from '@tanstack/react-query';
import type { NarrativeFeed } from '@/lib/insights/narrative';

export type { NarrativeFeed };

export function useBtcNarrative(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const q = useQuery<NarrativeFeed>({
    queryKey: ['insights', 'btc', 'narrative'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/insights/btc/narrative', { signal });
      if (!res.ok) throw new Error(`narrative ${res.status}`);
      return (await res.json()) as NarrativeFeed;
    },
    enabled,
    staleTime: 300_000,
    refetchInterval: 300_000,
    refetchOnWindowFocus: false,
  });
  return { data: q.data, loading: q.isLoading };
}
