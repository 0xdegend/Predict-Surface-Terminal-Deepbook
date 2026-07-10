'use client';

/**
 * useV2Positions — the connected account's open positions from the indexer's
 * `/accounts/{account_id}/positions` endpoint. Polled ~12s.
 *
 * IMPORTANT: the key is the internal ACCOUNT id (`acct.accountId`), NOT the
 * wallet owner and NOT the wrapper object — the indexer files positions under
 * `account_id` (see the OrderMinted event). Passing the wallet address returns
 * an empty list even when the account holds positions.
 */
import { useQuery } from '@tanstack/react-query';
import { getAccountPositions, qkV2 } from '@/lib/api/v2/client';
import type { V2Position } from '@/lib/api/v2/types';

export function useV2Positions(accountId?: string) {
  const q = useQuery<V2Position[]>({
    queryKey: qkV2.accountPositions(accountId ?? ''),
    queryFn: () => getAccountPositions(accountId!),
    enabled: !!accountId,
    refetchInterval: 12_000,
  });
  return { positions: q.data ?? [], isLoading: q.isLoading, error: q.error };
}
