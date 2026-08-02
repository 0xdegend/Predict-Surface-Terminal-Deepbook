'use client';

/**
 * useV2Positions — the connected account's open positions.
 *
 * 6-24: from the indexer's `/accounts/{account_id}/positions` endpoint, keyed by
 * the internal ACCOUNT id (NOT the wallet owner).
 *
 * 7-29: folded from the owner's order log, read by the wallet OWNER via the
 * whale-immune tx-sender path (a high-frequency bot buries the account-id scan of
 * the global stream — verified live). Pass `owner` on 7-29; the query still keys by
 * accountId so it dedupes with the history/style fetches for the same account.
 */
import { useQuery } from '@tanstack/react-query';
import { getAccountPositions, qkV2 } from '@/lib/api/v2/client';
import type { V2Position } from '@/lib/api/v2/types';

export function useV2Positions(accountId?: string, owner?: string) {
  const q = useQuery<V2Position[]>({
    queryKey: qkV2.accountPositions(accountId ?? ''),
    queryFn: () => getAccountPositions(accountId!, owner),
    enabled: !!accountId,
    refetchInterval: 12_000,
  });
  return { positions: q.data ?? [], isLoading: q.isLoading, error: q.error };
}
