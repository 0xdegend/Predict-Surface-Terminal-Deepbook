'use client';

/**
 * useStrikeAnalysis — live read on the strike the trader has picked: how far the
 * market has to travel, and how often it has actually travelled that far lately,
 * against what the surface is charging for it.
 *
 * Two deliberate cost controls, because the strike changes on every frame of a
 * slider drag:
 *  1. The candle tape is fetched ONCE and shared (60s server cache, one
 *     TanStack query key). It doesn't depend on the strike, so moving the strike
 *     never triggers a request — no matter how far or how often it moves.
 *  2. Both the fetch and the (O(n) window scan) recompute hang off a DEBOUNCED
 *     strike, so nothing runs until the trader settles. The tape isn't even
 *     requested until a strike has actually been committed.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebounced } from './use-debounced';
import { analyzeStrike, type StrikeAnalysis } from '@/lib/insights/strike-analysis';

export interface BtcCandles {
  available: boolean;
  asOf: number;
  intervalMs: number;
  times: number[];
  closes: number[];
}

/** How long the strike must hold still before we treat it as chosen. */
const SETTLE_MS = 450;

export function useStrikeAnalysis({
  strike,
  spot,
  isUp,
  expiryMs,
  impliedProb,
  now,
}: {
  strike: number | null;
  spot: number | null;
  isUp: boolean;
  expiryMs: number | null;
  /** The surface's fair probability for this strike/direction, 0-1. */
  impliedProb: number | null;
  /** Clock (ms) — passed in so this hook never reads Date.now() during render. */
  now: number;
}): { analysis: StrikeAnalysis | null; loading: boolean; settling: boolean } {
  // Everything downstream keys off the SETTLED strike/direction.
  const settledStrike = useDebounced(strike, SETTLE_MS);
  const settledIsUp = useDebounced(isUp, SETTLE_MS);
  const settling = strike !== settledStrike || isUp !== settledIsUp;

  const armed = settledStrike != null && spot != null && spot > 0;

  const q = useQuery<BtcCandles>({
    queryKey: ['insights', 'btc', 'candles'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/insights/btc/candles', { signal });
      if (!res.ok) throw new Error(`candles ${res.status}`);
      return (await res.json()) as BtcCandles;
    },
    // No strike picked yet → never asks for the tape at all.
    enabled: armed,
    staleTime: 60_000,
    refetchInterval: 60_000,
    // The tape is 33h of history; a stale one still answers the question, so
    // don't blank the panel while it refreshes.
    refetchOnWindowFocus: false,
  });

  // Minutes left, rounded to the minute the tape is sampled at. Bucketed so the
  // countdown ticking doesn't re-run the scan every second.
  const minutesToExpiry = useMemo(() => {
    if (expiryMs == null) return null;
    return Math.max(1, Math.round((expiryMs - now) / 60_000));
  }, [expiryMs, now]);

  const analysis = useMemo(() => {
    const closes = q.data?.closes;
    if (!armed || !closes?.length || minutesToExpiry == null) return null;
    return analyzeStrike({
      closes,
      spot: spot as number,
      strike: settledStrike as number,
      isUp: settledIsUp,
      minutesToExpiry,
      impliedProb,
    });
  }, [armed, q.data?.closes, spot, settledStrike, settledIsUp, minutesToExpiry, impliedProb]);

  return { analysis, loading: armed && q.isLoading, settling };
}
