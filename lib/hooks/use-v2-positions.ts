'use client';

/**
 * useV2Positions — the connected account's open positions, from the owner-scoped
 * indexer endpoint (/accounts/{owner}/positions). Polled ~12s. Empty on testnet
 * today; the row shape is read defensively (see V2Position) until populated.
 */
import { useQuery } from '@tanstack/react-query';
import { getAccountPositions, qkV2 } from '@/lib/api/v2/client';
import type { V2Position } from '@/lib/api/v2/types';

export function useV2Positions(owner?: string) {
  const q = useQuery<V2Position[]>({
    queryKey: qkV2.accountPositions(owner ?? ''),
    queryFn: () => getAccountPositions(owner!),
    enabled: !!owner,
    refetchInterval: 12_000,
  });
  return { positions: q.data ?? [], isLoading: q.isLoading, error: q.error };
}
