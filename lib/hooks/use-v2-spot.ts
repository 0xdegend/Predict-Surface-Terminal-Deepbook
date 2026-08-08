'use client';

/**
 * useV2Spot — live BTC spot ($) from the propbook pyth feed. Shares the exact query
 * key the nav tape uses (qkV2.pythLatest), so extra callers dedupe to ZERO additional
 * fetches — they just subscribe to the one running query.
 *
 * Freshness comes from the gRPC checkpoint stream (Phase 4): `useLivePyth` refreshes
 * this query the instant the feed writes on-chain (~0.4s), so we back the poll right
 * off to a slow safety net while the stream is live, and only fall back to the old
 * ~1.5s poll when the stream is down. Net: fresher when streaming works, no worse
 * when it doesn't.
 */
import { useQuery } from '@tanstack/react-query';
import { getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { useLivePyth, useCheckpointStreamStatus } from '@/lib/hooks/use-checkpoint-stream';

export function useV2Spot(): number | null {
  useLivePyth(); // push-refresh this query off the checkpoint stream (ref-counted)
  const streamLive = useCheckpointStreamStatus() === 'live';
  const { data } = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(predictV2Config.asset.pythFeedId),
    // Stream drives freshness; poll is a backstop. Slow while live, prompt when down.
    refetchInterval: streamLive ? 12_000 : 1_500,
  });
  return pythSpot(data ?? null);
}
