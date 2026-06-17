'use client';

/**
 * useSkewTraders — the roster of addresses that have traded through Skew (from
 * the on-chain `FeeCharged` events; see lib/leaderboard/skew-traders.ts). Powers
 * the leaderboard's "Skew traders" scope. `available` is false when the fee
 * router isn't configured for this network, so the UI can hide the toggle.
 */
import { useQuery } from '@tanstack/react-query';
import { predictConfig } from '@/config/predict';
import { fetchSkewTraders, type SkewTraders } from '@/lib/leaderboard/skew-traders';

export function useSkewTraders() {
  const available = !!predictConfig.skewFeePackageId;
  const q = useQuery({
    queryKey: ['skew-traders', predictConfig.network],
    queryFn: ({ signal }) => fetchSkewTraders(signal),
    enabled: available,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  return {
    data: q.data as SkewTraders | undefined,
    loading: q.isLoading,
    error: q.error instanceof Error ? q.error.message : null,
    available,
  };
}
