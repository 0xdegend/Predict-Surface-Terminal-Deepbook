'use client';

/**
 * useV2Pricers — live pricing snapshots for a SET of ExpiryMarkets at once,
 * for the market picker's Price/IV columns. Bounded by design: callers pass
 * only the currently-visible rows (a page), so the simulate load stays small.
 *
 * Shares TanStack cache with useV2Pricer (same `qkV2.pricer(id)` key), so the
 * selected market's fast 5s ticket poll and this slower list readout dedupe
 * onto one query per market. Seeded from the server pricer (initialData) so the
 * visible rows paint with real data on first render.
 */
import { useQueries } from '@tanstack/react-query';
import { simulateLivePricer, type LivePricer } from '@/lib/sui/v2/pricer';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { qkV2 } from '@/lib/api/v2/client';

export function useV2Pricers(
  marketIds: string[],
  seeds: Record<string, LivePricer>,
  intervalMs = 20_000,
): Record<string, LivePricer> {
  // Health-aware read client so the list keeps pricing if the primary node stalls.
  const client = useV2ReadClient();
  const results = useQueries({
    queries: marketIds.map((id) => ({
      queryKey: qkV2.pricer(id),
      queryFn: () => simulateLivePricer(client.core, id),
      initialData: seeds[id]?.expiryMarketId === id ? seeds[id] : undefined,
      refetchInterval: intervalMs,
      // A momentarily-stale feed (expired market / oracle blip) throws — don't spin.
      retry: 1,
    })),
  });

  const out: Record<string, LivePricer> = {};
  marketIds.forEach((id, i) => {
    const d = results[i]?.data;
    if (d) out[id] = d;
  });
  return out;
}
