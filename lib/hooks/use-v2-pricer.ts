'use client';

/**
 * useV2Pricer — live pricing snapshot for one ExpiryMarket, refreshed ~5s by
 * simulating load_live_pricer on-chain. Seed with a server-simulated pricer
 * (initialData) so the screen paints instantly, then it stays live client-side.
 */
import { useQuery } from '@tanstack/react-query';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { simulateLivePricer, type LivePricer } from '@/lib/sui/v2/pricer';
import { qkV2 } from '@/lib/api/v2/client';

export function useV2Pricer(marketId: string | null, seed?: LivePricer) {
  const client = useCurrentClient();
  return useQuery<LivePricer>({
    queryKey: qkV2.pricer(marketId ?? ''),
    queryFn: () => simulateLivePricer(client.core, marketId!),
    enabled: !!marketId,
    initialData: seed && seed.expiryMarketId === marketId ? seed : undefined,
    refetchInterval: 5_000,
    // A momentarily-stale feed (expired market / oracle blip) throws — don't spin.
    retry: 1,
  });
}
