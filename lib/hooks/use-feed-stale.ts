'use client';

/**
 * useSpotFeedStale — is the BTC spot feed frozen upstream?
 *
 * The top price, the price chart, and every on-chain quote all derive from the
 * same Pyth spot observations (propbook). When the upstream price pusher stalls
 * (a recurring testnet incident — see the grpc/oracle stall notes), the newest
 * observation stops advancing while the wall clock keeps moving, so its age grows
 * without bound. We read that age off the SAME shared spot query (`qkV2.pythLatest`
 * — no extra fetch, dedupes with the tape + chart) and call it stale past a
 * threshold, so the UI can show an honest "prices delayed" state instead of a
 * frozen number and infinite spinners.
 *
 * Age (not a "timestamp stopped advancing since mount" check) on purpose: age is
 * correct on a COLD load during an ongoing outage (it immediately sees a 40-minute-
 * old price), where a since-mount check would wait the full threshold first.
 * Browser clock skew is only a few seconds, negligible against the threshold.
 */
import { useQuery } from '@tanstack/react-query';
import { getPythLatest, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { useNow } from '@/lib/hooks/use-now';

/** No fresh BTC spot observation for this long → the feed is stale (upstream).
 *  ~90s: a healthy feed advances every ~1.5s, so this never flaps on a brief
 *  network hiccup, but still surfaces a real stall well inside two minutes. */
export const SPOT_STALE_AFTER_MS = 90_000;

export function useSpotFeedStale(): { stale: boolean; ageMs: number | null } {
  const { data } = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(predictV2Config.asset.pythFeedId),
    refetchInterval: 1500,
  });
  // Shared 1s clock so the age advances (and a stall is detected) without a fresh
  // fetch and without a per-component timer.
  const now = useNow(0);
  const ts = data?.source_timestamp_ms ?? data?.checkpoint_timestamp_ms ?? null;
  if (ts == null) return { stale: false, ageMs: null }; // still loading → not "stale"
  const ageMs = Math.max(0, now - ts);
  return { stale: ageMs > SPOT_STALE_AFTER_MS, ageMs };
}
