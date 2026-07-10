'use client';

/**
 * useV2History — the account's realized trade history from the indexer's order
 * EVENT log (`/accounts/{account_id}/orders`), the authoritative append-only
 * record of every mint + redeem. Closed trades are derived from the `*_redeemed`
 * events joined to their mints (see deriveV2HistoryFromOrders). Keyed by the
 * internal account_id (NOT the wallet owner). Polled ~15s.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAccountOrders, qkV2 } from '@/lib/api/v2/client';
import { deriveV2HistoryFromOrders } from '@/lib/portfolio/v2';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';
import type { PastPrediction } from '@/lib/portfolio/history';

export function useV2History(
  accountId: string | undefined,
  marketMap?: Map<string, V2Market>,
): { history: PastPrediction[]; isLoading: boolean } {
  const q = useQuery<V2OrderEvent[]>({
    queryKey: qkV2.accountOrders(accountId ?? ''),
    queryFn: () => getAccountOrders(accountId!),
    enabled: !!accountId,
    refetchInterval: 15_000,
  });
  const history = useMemo(
    () => deriveV2HistoryFromOrders(q.data ?? [], marketMap),
    [q.data, marketMap],
  );
  return { history, isLoading: q.isLoading };
}
