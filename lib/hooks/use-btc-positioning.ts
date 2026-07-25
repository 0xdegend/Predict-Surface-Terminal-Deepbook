'use client';

/**
 * useBtcPositioning — options/flow positioning from `/api/insights/btc/positioning`
 * (Clawby PRO, fetched server-side + cached 60s). Powers the Options page's
 * "Positioning & flow" strip. The browser never touches Clawby directly (key +
 * rate limits live server-side). Pass `{ enabled: false }` to stay dark.
 */
import { useQuery } from '@tanstack/react-query';
import type { Positioning } from '@/lib/insights/positioning';

export type { Positioning };

export function useBtcPositioning(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const q = useQuery<Positioning>({
    queryKey: ['insights', 'btc', 'positioning'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/insights/btc/positioning', { signal });
      if (!res.ok) throw new Error(`positioning ${res.status}`);
      return (await res.json()) as Positioning;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  return { data: q.data, loading: q.isLoading };
}
