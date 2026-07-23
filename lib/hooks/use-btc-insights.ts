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

export interface BtcInsights {
  available: boolean;
  asOf: number;
  spot: number | null;
  change24hPct: number | null;
  oiUsd: number | null;
  funding: { binancePct: number | null; avgPct: number | null };
  liq24h: { totalUsd: number | null; longUsd: number | null; shortUsd: number | null };
  maxPain: { strike: number; date: string } | null;
  sentiment: { value: number; label: string } | null;
}

export function useBtcInsights(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const q = useQuery<BtcInsights>({
    queryKey: ['insights', 'btc'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/insights/btc', { signal });
      if (!res.ok) throw new Error(`insights ${res.status}`);
      return (await res.json()) as BtcInsights;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  return { data: q.data, loading: q.isLoading };
}
