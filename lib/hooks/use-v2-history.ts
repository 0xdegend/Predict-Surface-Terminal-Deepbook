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
import { mergeHistoryRows, fetchLegacyHistory } from '@/lib/portfolio/legacy-history';
import { toFloat } from '@/config/scale';
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

  // The wallet's carried-over trades from retired deployments. Fetched rather than
  // imported: the snapshots are ~960 KB and grow per release, while one visitor needs only
  // their own rows (see /api/v2/legacy-history). Cached hard because the snapshot is a
  // static file — it cannot change between renders, only between deploys.
  const legacyQ = useQuery<PastPrediction[]>({
    queryKey: ['v2', 'legacy-history', owner?.toLowerCase() ?? ''],
    queryFn: ({ signal }) => fetchLegacyHistory(owner, signal),
    enabled: !!owner,
    staleTime: Infinity,
    gcTime: Infinity,
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

  // Settlement price per market ($, or null while live) — lets the derivation recover a
  // SETTLED LOSS that has no captured redeem event (keeper-cleared, invisible to the owner
  // scan) so it still shows in history instead of vanishing. Same source the positions hook
  // uses for its settled marks.
  const settlements = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [id, st] of Object.entries(marketStates)) {
      const sp = st?.settlement?.settlement_price;
      m.set(id, sp != null ? toFloat(sp) : null);
    }
    return m;
  }, [marketStates]);

  // Live history with the wallet's carried-over trades merged underneath, so a returning
  // trader's record is continuous (a no-op for a new wallet, and on a snapshot's own
  // deployment, where the live read already returns those trades).
  const history = useMemo(
    () => mergeHistoryRows(deriveV2HistoryFromOrders(q.data ?? [], mergedMap, settlements), legacyQ.data ?? []),
    [q.data, mergedMap, settlements, legacyQ.data],
  );
  // Report loading until BOTH halves are in. The carried rows used to be bundled, so they
  // were present on the first render; without this the tab would paint a short history and
  // then grow, which reads as trades appearing out of nowhere.
  return { history, isLoading: q.isLoading || legacyQ.isLoading };
}
