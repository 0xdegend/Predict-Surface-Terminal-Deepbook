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
import { mergeLegacyHistory } from '@/lib/portfolio/legacy-history';
import { useV2MarketStates } from './use-v2-market-states';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';
import type { PastPrediction } from '@/lib/portfolio/history';

export function useV2History(
  accountId: string | undefined,
  marketMap?: Map<string, V2Market>,
  owner?: string,
): { history: PastPrediction[]; isLoading: boolean } {
  const q = useQuery<V2OrderEvent[]>({
    queryKey: qkV2.accountOrders(accountId ?? ''),
    queryFn: () => getAccountOrders(accountId!, owner),
    enabled: !!accountId,
    refetchInterval: 15_000,
  });

  // A history row's market is usually SETTLED, so it has dropped out of the
  // active marketMap passed in — and without its `tick_size` the stored ticks
  // can't be turned into a strike price, so the row renders "BTC ≤ $0.00".
  // Fetch each order's market state directly and merge it in, so strikes resolve
  // for long-settled markets too.
  const orderMarketIds = useMemo(() => {
    const ids = new Set<string>();
    for (const o of q.data ?? []) if (o.expiry_market_id) ids.add(o.expiry_market_id);
    return [...ids];
  }, [q.data]);
  const marketStates = useV2MarketStates(orderMarketIds);
  const mergedMap = useMemo(() => {
    const m = new Map<string, V2Market>(marketMap ?? []);
    for (const st of Object.values(marketStates)) {
      if (st?.market) m.set(st.market.expiry_market_id, st.market);
    }
    return m;
  }, [marketMap, marketStates]);

  // Live 8-06 history, with the wallet's carried-over 6-24 trades merged underneath so
  // a returning trader's history is continuous (a no-op on 6-24 and for new wallets).
  const history = useMemo(
    () => mergeLegacyHistory(owner, deriveV2HistoryFromOrders(q.data ?? [], mergedMap)),
    [q.data, mergedMap, owner],
  );
  return { history, isLoading: q.isLoading };
}
