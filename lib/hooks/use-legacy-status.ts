'use client';

/**
 * useLegacyStatus — is the OLD deployment's server still up? Polled gently (60s).
 *
 * Drives the graceful sunset: once the new deployment is selectable, a Legacy
 * server that has gone dark means the old oracles have wound down, so the toggle
 * marks Legacy "offline" (and we steer users to Latest). Until then this is
 * dormant. `online` defaults true (don't cry offline on the first tick / a blip).
 */
import { useQuery } from '@tanstack/react-query';
import { getPredictConfig } from '@/config/predict';

export function useLegacyStatus() {
  const url = getPredictConfig().serverUrl; // legacy (frozen) server
  const q = useQuery({
    queryKey: ['legacy', 'status'],
    queryFn: async () => {
      const res = await fetch(`${url}/status`, { cache: 'no-store' });
      return res.ok;
    },
    refetchInterval: 60_000,
    retry: 1,
    staleTime: 30_000,
  });
  return { online: q.data !== false, checked: q.isFetched };
}
