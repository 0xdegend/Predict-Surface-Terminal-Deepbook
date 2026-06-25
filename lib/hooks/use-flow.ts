'use client';

/**
 * useFlow — the Analytics order-flow spine (Phase 1).
 *
 * One cheap, polling fetch of the global mint/redeem event streams → a
 * normalized newest-first tape + UP/DOWN dollar sentiment. Mirrors the
 * leaderboard's single-fetch model (no per-manager fan-out, never trips the
 * public server's rate limit), but with a recent window + a refetch interval so
 * the tape feels live. Server-data only — renders for any visitor, no wallet.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPositionsMinted, getPositionsRedeemed, qk } from '@/lib/api/client';
import {
  buildFlowTape,
  aggregateSentiment,
  type FlowEvent,
  type Sentiment,
} from '@/lib/analytics/flow';

/** Recent-window depth pulled for the tape. Enough to fill the list + compute a
 *  representative rolling sentiment, small enough to poll often and politely. */
const EVENT_WINDOW = 400;
/** Rows kept on the tape (paginated in the UI). */
const TAPE_LIMIT = 200;
/** Rolling sentiment lookback. */
const SENTIMENT_WINDOW_MS = 60 * 60 * 1000; // 1h
/** Poll cadence — the live heartbeat. */
const REFETCH_MS = 8_000;
/** A mint at/above this percentile of window cost is flagged a "whale". */
const WHALE_PERCENTILE = 0.9;

export interface UseFlow {
  tape: FlowEvent[];
  /** UP/DOWN dollar sentiment over the rolling window. */
  sentiment: Sentiment;
  /** Adaptive DUSDC threshold above which a bet is "big" (window 90th pct). */
  whaleThreshold: number;
  loading: boolean;
  /** True during a background refetch (drives the refresh-pulse). */
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * Shared raw-event query — the single source for both the flow tape and the
 * market heatmap. Same query key, so TanStack dedupes it to one network fetch no
 * matter how many analytics widgets are mounted.
 */
export function useFlowEvents() {
  return useQuery({
    queryKey: qk.flow,
    queryFn: async () => {
      const [minted, redeemed] = await Promise.all([
        getPositionsMinted(EVENT_WINDOW),
        getPositionsRedeemed(EVENT_WINDOW),
      ]);
      return { minted, redeemed };
    },
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
  });
}

export function useFlow(): UseFlow {
  const q = useFlowEvents();

  const { tape, sentiment, whaleThreshold } = useMemo(() => {
    const minted = q.data?.minted ?? [];
    const redeemed = q.data?.redeemed ?? [];
    // Anchor the rolling window to the newest event we hold, not the wall clock:
    // pure (deterministic in the data), and it tracks data freshness rather than
    // drifting if the public stream lags. Avoids an impure Date.now() in render.
    let latest = 0;
    for (const e of minted) if (e.checkpoint_timestamp_ms > latest) latest = e.checkpoint_timestamp_ms;
    const since = latest > 0 ? latest - SENTIMENT_WINDOW_MS : 0;
    return {
      tape: buildFlowTape(minted, redeemed, TAPE_LIMIT),
      sentiment: aggregateSentiment(minted, since),
      whaleThreshold: percentile(
        buildFlowTape(minted, [], EVENT_WINDOW)
          .filter((f) => f.kind === 'mint')
          .map((f) => f.amount),
        WHALE_PERCENTILE,
      ),
    };
  }, [q.data]);

  return {
    tape,
    sentiment,
    whaleThreshold,
    loading: q.isLoading,
    refreshing: q.isFetching && !q.isLoading,
    error: q.isError ? 'Could not load the live flow.' : null,
    refetch: () => void q.refetch(),
  };
}
