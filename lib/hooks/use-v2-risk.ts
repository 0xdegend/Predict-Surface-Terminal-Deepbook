'use client';

/**
 * useV2Risk — everything the vault-risk panel needs, from live v2 data:
 *  - the vault snapshot (NAV, shares, idle, deployed) via useVaultV2;
 *  - per-market open interest for the active book (fanned out, one query each,
 *    bounded by the active-market count) → exposure + coverage;
 *  - the flush history → the share-price series.
 *
 * All the arithmetic lives in lib/risk/v2 (pure, unit-tested); this hook only
 * wires the queries and de-scales into it.
 */
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useVaultV2 } from './use-vault-v2';
import { useV2Markets } from './use-v2-markets';
import { getMarketOpenInterest, getVaultFlushes, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import {
  computeVaultRisk,
  sharePriceSeries,
  type VaultRisk,
  type SharePricePoint,
} from '@/lib/risk/v2';
import type { V2Market, V2OpenInterest, V2VaultFlush } from '@/lib/api/v2/types';

export interface UseV2Risk {
  risk?: VaultRisk;
  series: SharePricePoint[];
  /** Newest keeper flush, for the "last updated / next update" line. */
  latestFlush?: V2VaultFlush;
  isLoading: boolean;
}

export function useV2Risk(initialMarkets: V2Market[] = []): UseV2Risk {
  const { vault, nav } = useVaultV2();
  const markets = useV2Markets(initialMarkets);

  // Per-market open interest — one query per active market, deduped by TanStack.
  const oiQueries = useQueries({
    queries: markets.map((m) => ({
      queryKey: qkV2.marketOpenInterest(m.expiry_market_id),
      queryFn: () => getMarketOpenInterest(m.expiry_market_id),
      staleTime: 12_000,
      refetchInterval: 15_000,
    })),
  });
  // oiQueries is a fresh array each render; key the memo on when its data last
  // changed (a simple string) rather than the array identity.
  const oiStamp = oiQueries.map((q) => q.dataUpdatedAt).join(',');
  const oiByMarket = useMemo(() => {
    const map = new Map<string, V2OpenInterest>();
    markets.forEach((m, i) => {
      const oi = oiQueries[i]?.data;
      if (oi) map.set(m.expiry_market_id, oi);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, oiStamp]);

  const flushesQ = useQuery<V2VaultFlush[]>({
    queryKey: qkV2.vaultFlushes,
    queryFn: () => getVaultFlushes(predictV2Config.shared.poolVault, 200),
    refetchInterval: 30_000,
  });

  // The snapshot prefers the server NAV (full pool value incl. deployed capital);
  // idle/shares fall back to the on-chain views when the server lags.
  const cur = nav?.current ?? null;
  const risk = useMemo<VaultRisk | undefined>(() => {
    const poolValue = cur ? fromQuote(cur.pool_value) : vault ? fromQuote(vault.idleBalance) : null;
    if (poolValue == null) return undefined;
    const totalShares = cur
      ? fromQuote(cur.total_supply)
      : vault
        ? fromQuote(vault.plpTotalSupply)
        : 0;
    const idle = vault ? fromQuote(vault.idleBalance) : cur ? fromQuote(cur.idle_balance_after) : 0;
    const deployed = cur ? fromQuote(cur.active_market_nav) : 0;
    return computeVaultRisk({ poolValue, totalShares, idle, deployed }, markets, oiByMarket, fromQuote);
  }, [cur, vault, markets, oiByMarket]);

  const series = useMemo(
    () => sharePriceSeries(flushesQ.data ?? [], fromQuote),
    [flushesQ.data],
  );

  return {
    risk,
    series,
    latestFlush: nav?.latest_flush ?? undefined,
    isLoading: (!vault && !nav) || flushesQ.isLoading,
  };
}
