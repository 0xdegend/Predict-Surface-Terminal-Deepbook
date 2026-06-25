'use client';

/**
 * useMarketGrid — the market-heatmap data spine (Analytics Phase 2).
 *
 * Two queries, combined into one MarketCell[] per active market:
 *   1. the shared flow events (qk.flow — deduped with the live tape), and
 *   2. the active oracles' live SVI/forward snapshots (for ATM implied vol).
 *
 * The oracle-states query mirrors the risk page's server build, but client-side
 * with a gentle refetch (this is a map, not the 8s tape). Server-data only — no
 * wallet — so the whole heatmap renders for any visitor.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getOracles, getOracleState } from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import { useFlowEvents } from '@/lib/hooks/use-flow';
import { buildMarketGrid, type MarketCell, type MarketInput } from '@/lib/analytics/market-grid';

/** Map refresh — slower than the tape; the surface itself polls ~2s, so this is
 *  deliberately gentle (fewer per-oracle state fetches). */
const REFETCH_MS = 20_000;

export interface UseMarketGrid {
  cells: MarketCell[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
}

export function useMarketGrid(): UseMarketGrid {
  const ev = useFlowEvents();

  // Active oracles + their latest SVI/forward — the inputs ATM IV is read from.
  const states = useQuery({
    queryKey: ['analytics', 'market-inputs'],
    queryFn: async (): Promise<MarketInput[]> => {
      const oracles = await getOracles();
      const active = oracles.filter((o) => o.status === 'active').sort((a, b) => a.expiry - b.expiry);
      const snaps = await Promise.all(active.map((o) => getOracleState(o.oracle_id)));
      return snaps.flatMap((st, i) => {
        if (!st.latest_svi || !st.latest_price) return [];
        return [{ oracle: active[i], svi: parseSvi(st.latest_svi), forward: toFloat(st.latest_price.forward) }];
      });
    },
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
  });

  // Anchor "now" to when the snapshot was fetched (pure — no Date.now() in
  // render, and it only moves on a refetch, so the grid doesn't churn every
  // second; ATM IV is re-derived against fresh forwards on each ~20s refresh).
  const nowMs = states.dataUpdatedAt || ev.dataUpdatedAt;

  const cells = useMemo(() => {
    const inputs = states.data ?? [];
    const minted = ev.data?.minted ?? [];
    const redeemed = ev.data?.redeemed ?? [];
    if (inputs.length === 0) return [];
    // The map is "tap to trade", so only surface markets that are still live —
    // active oracles past their expiry are awaiting settlement and can't be
    // minted. (The flow tape still shows their settled/expired history.)
    return buildMarketGrid(inputs, minted, redeemed, nowMs).filter((c) => c.expiry > nowMs);
  }, [states.data, ev.data, nowMs]);

  return {
    cells,
    loading: states.isLoading || ev.isLoading,
    refreshing: (states.isFetching || ev.isFetching) && !(states.isLoading || ev.isLoading),
    error: states.isError || ev.isError ? 'Could not load the market grid.' : null,
    refetch: () => {
      void states.refetch();
      void ev.refetch();
    },
  };
}
