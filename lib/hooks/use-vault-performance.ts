'use client';

/**
 * useVaultPerformance — the vault's price-per-share history + realized LP profit,
 * from the indexer (v2's stand-in for legacy's `/vault/performance`).
 *
 *  - Share price series: `/vaults/:id/flushes` — each keeper flush marks the pool,
 *    so pool_value / total_supply per flush IS the NAV-per-share over time.
 *  - Realized LP profit: `/vaults/:id/profit` — the LP share of each settled
 *    market's profit; summed over the retained window.
 *
 * Server-only (no wallet), so it renders for any visitor. Purely additive — the
 * on-chain vault reads (useVaultV2) are untouched.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getVaultFlushes, getVaultProfit, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import type { V2VaultFlush, V2VaultProfit } from '@/lib/api/v2/types';

export interface SharePoint {
  t: number; // ms
  price: number; // NAV per share (DUSDC)
}

export interface VaultPerformance {
  points: SharePoint[];
  sharePriceNow: number | null;
  /** % change over the retained window (last vs first point). */
  changePct: number | null;
  /** Realized LP profit summed over the window (DUSDC, signed). */
  lpProfitTotal: number;
  /** Number of settlements the LP profit sums over. */
  settlements: number;
  loading: boolean;
}

export function useVaultPerformance(): VaultPerformance {
  const vaultId = predictV2Config.shared.poolVault;

  const flushesQ = useQuery<V2VaultFlush[]>({
    queryKey: qkV2.vaultFlushes,
    queryFn: () => getVaultFlushes(vaultId, 200),
    refetchInterval: 30_000,
    enabled: !!vaultId,
  });
  const profitQ = useQuery<V2VaultProfit[]>({
    queryKey: qkV2.vaultProfit,
    queryFn: () => getVaultProfit(vaultId, 200),
    refetchInterval: 30_000,
    enabled: !!vaultId,
  });

  return useMemo(() => {
    const points: SharePoint[] = (flushesQ.data ?? [])
      .filter((f) => Number(f.total_supply) > 0)
      .map((f) => ({
        t: f.checkpoint_timestamp_ms,
        price: Number(f.pool_value) / Number(f.total_supply),
      }))
      .sort((a, b) => a.t - b.t);

    const first = points[0]?.price ?? null;
    const last = points.length ? points[points.length - 1].price : null;
    const changePct = first != null && last != null && first > 0 ? (last / first - 1) * 100 : null;

    const profit = profitQ.data ?? [];
    const lpProfitTotal = profit.reduce((s, p) => s + fromQuote(p.lp_profit), 0);

    return {
      points,
      sharePriceNow: last,
      changePct,
      lpProfitTotal,
      settlements: profit.length,
      loading: flushesQ.isLoading || profitQ.isLoading,
    };
  }, [flushesQ.data, profitQ.data, flushesQ.isLoading, profitQ.isLoading]);
}
