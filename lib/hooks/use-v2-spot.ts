'use client';

/**
 * useV2Spot — live BTC spot ($) from the propbook pyth feed (~1.5s). Shares the
 * exact query key the nav tape uses (qkV2.pythLatest), so extra callers dedupe to
 * ZERO additional fetches — they just subscribe to the one running query.
 */
import { useQuery } from '@tanstack/react-query';
import { getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';

export function useV2Spot(): number | null {
  const { data } = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(predictV2Config.asset.pythFeedId),
    refetchInterval: 1500,
  });
  return pythSpot(data ?? null);
}
