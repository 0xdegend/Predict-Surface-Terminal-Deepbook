'use client';

/**
 * useV2TraderStyle — the derived trading archetype for one v2 trader, from their
 * COMPLETE order history (`/accounts/{account_id}/orders`, which spans every
 * market they've traded — not just the recent window). Reuses the shared
 * classifier (classifyV2Traders → classifyStyle) so a trader reads the same
 * archetype on their profile as in the Analytics roster.
 *
 * Shares the `qkV2.accountOrders` cache key with useV2PortfolioPositions, so the
 * profile fetches the order log once for both the positions and the style.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAccountOrders, qkV2 } from '@/lib/api/v2/client';
import { classifyV2Traders } from '@/lib/analytics/v2-trader-style';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { TraderStyle } from '@/lib/analytics/trader-style';

export function useV2TraderStyle(
  accountId?: string,
  owner?: string,
): { style: TraderStyle | null; loading: boolean } {
  const q = useQuery<V2OrderEvent[]>({
    queryKey: qkV2.accountOrders(accountId ?? ''),
    queryFn: () => getAccountOrders(accountId!, owner),
    enabled: !!accountId,
    staleTime: 15_000,
  });

  const style = useMemo(() => {
    const orders = q.data ?? [];
    if (orders.length === 0) return null;
    // One-owner feed → a single classified trader; the map key is arbitrary.
    const res = classifyV2Traders(new Map([['all', orders]]), 1);
    return res.traders[0]?.style ?? null;
  }, [q.data]);

  return { style, loading: q.isLoading };
}
