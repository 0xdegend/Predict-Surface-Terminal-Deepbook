'use client';

/**
 * useV2Pricer — live pricing snapshot for one ExpiryMarket, refreshed ~5s by
 * simulating load_live_pricer on-chain. Seed with a server-simulated pricer
 * (initialData) so the screen paints instantly, then it stays live client-side.
 */
import { useQuery } from '@tanstack/react-query';
import { simulateLivePricer, type LivePricer } from '@/lib/sui/v2/pricer';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { qkV2 } from '@/lib/api/v2/client';
import { useLiveRefreshOnPyth } from '@/lib/hooks/use-checkpoint-stream';

export function useV2Pricer(marketId: string | null, seed?: LivePricer) {
  // Health-aware read client (not the wallet client): if the primary fullnode
  // stalls, reads fail over to a synced node and the surface keeps pricing.
  const client = useV2ReadClient();
  // Phase 4: nudge the odds off the checkpoint stream so they track price without
  // waiting the full 5s poll — but capped (a simulate is heavier than a spot read),
  // so this refreshes at most ~once/2.5s, with the 5s poll as the floor.
  useLiveRefreshOnPyth(qkV2.pricer(marketId ?? ''), 2_500, !!marketId);
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
