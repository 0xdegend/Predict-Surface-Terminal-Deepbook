'use client';

/**
 * useBtcInsights — live BTC market context from `/api/insights/btc` (Clawby data,
 * fetched server-side + cached). Powers the surface's right-rail "BTC market
 * context" card. Polls on the route's cache cadence; the browser never touches
 * Clawby directly (the key + rate limits live server-side).
 *
 * Pass `{ enabled: false }` to keep it mounted-but-dark (no fetch, no polling) —
 * used by the co-pilot so a gated/coming-soon page spends zero Clawby credits.
 */
import { useQuery } from '@tanstack/react-query';
import type { MarketContext } from '@/lib/insights/context';

// The context shape now lives in the pure engine (lib/insights/context) so the
// route, this hook, and the generators all share one definition. Re-exported here
// (with the legacy `BtcInsights` alias) so existing importers keep resolving.
export type { MarketContext };
export type BtcInsights = MarketContext;

export function useBtcInsights(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const q = useQuery<MarketContext>({
    queryKey: ['insights', 'btc'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/insights/btc', { signal });
      if (!res.ok) throw new Error(`insights ${res.status}`);
      return (await res.json()) as MarketContext;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  return { data: q.data, loading: q.isLoading };
}
