'use client';

/**
 * useVolHistory — one market's ATM implied-vol history (Analytics Phase 3).
 *
 * Fetches the chosen oracle's SVI + price history (the same streams that drive
 * the surface time-travel scrub) and reconstructs ATM IV at each past snapshot.
 * Disabled until a market is selected. Server-data only — no wallet.
 */
import { useQuery } from '@tanstack/react-query';
import { getSviHistory, getPriceHistory } from '@/lib/api/client';
import { reconstructAtmIvHistory, type IvHistoryPoint } from '@/lib/analytics/vol-curves';

const SVI_LIMIT = 150;
const PRICE_LIMIT = 200;
const REFETCH_MS = 30_000;

export interface UseVolHistory {
  series: IvHistoryPoint[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

/** `market` carries just what the reconstruction needs (id + expiry). */
export function useVolHistory(market: { oracleId: string; expiry: number } | null): UseVolHistory {
  const q = useQuery({
    queryKey: ['analytics', 'iv-history', market?.oracleId],
    enabled: !!market,
    queryFn: async (): Promise<IvHistoryPoint[]> => {
      const [svi, prices] = await Promise.all([
        getSviHistory(market!.oracleId, SVI_LIMIT),
        getPriceHistory(market!.oracleId, PRICE_LIMIT),
      ]);
      return reconstructAtmIvHistory(svi, prices, market!.expiry);
    },
    refetchInterval: REFETCH_MS,
  });

  return {
    series: q.data ?? [],
    loading: q.isLoading && !!market,
    refreshing: q.isFetching && !q.isLoading,
    error: q.isError ? 'Could not load this market’s vol history.' : null,
  };
}
