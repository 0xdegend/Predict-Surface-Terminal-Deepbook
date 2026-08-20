'use client';

/**
 * use-v2-pyth-history — shared query options for the price chart's history, plus a
 * prefetch hook so the (slow) backfill starts at PAGE LOAD instead of when the Chart
 * tab first mounts.
 *
 * WHY: the chart's history is reconstructed by walking `suix_queryEvents` one 50-event
 * page at a time (the RPC hard-caps the page size), and the feed is dense, so the full
 * ~3-min window costs ~18 SEQUENTIAL pages (~15-20s). The hero defaults to the 3-D
 * Surface, and the chart only mounts when the trader switches to it — so that whole
 * walk used to start on the switch, leaving them staring at the fast SEED slice for a
 * long while before the full window filled in. Prefetching from the always-mounted
 * trade screen runs the walk in the background while they're on Surface, so opening
 * Chart usually lands straight on the full window.
 *
 * The chart component uses these SAME option objects for its own `useQuery`, so the
 * prefetch and the live query share one cache entry (no double walk).
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPythHistory, getPythLatest, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { useLivePyth } from '@/lib/hooks/use-checkpoint-stream';
import { mergePythTape } from '@/lib/store/pyth-tape';

const PID = predictV2Config.asset.pythFeedId;

/** Distinct-second points for the FAST first paint (~1-2 event pages, a few seconds). */
export const PYTH_SEED_POINTS = 15;
/** Target for the full backfill. Each event page (50 events, RPC-capped) yields ~10
 *  distinct-second points, so ~100 points ≈ a ~10-page walk (~10s) and a ~90-100s
 *  window — plenty of context for the 1-minute markets, and roughly HALF the old
 *  18-page / ~3-min walk so the prefetch reliably finishes before the trader opens
 *  Chart. (`onchainPythObservations` still hard-caps at 18 pages as a backstop.) */
const PYTH_FULL_POINTS = 100;

/** Fast shallow slice — paints the chart in seconds; the full history swaps in behind. */
export const pythSeedQueryOptions = {
  queryKey: [...qkV2.pythHistory, 'seed'] as const,
  queryFn: () => getPythHistory(PID, PYTH_SEED_POINTS),
  staleTime: Infinity, // one-shot: the full history + live edge keep the chart fresh after
};

/** The ~90s cold-start backfill. ONE-SHOT: no periodic re-walk — once painted, the
 *  live edge (latestQ + the rAF engine) extends history rightward and the pyth-tape
 *  buffer keeps a current copy across chart unmounts, so re-walking every 60s is pure
 *  waste. It still refetches on window FOCUS if stale (>60s), to heal any gap after the
 *  tab was in the background (where the live reads paused). */
export const pythHistoryQueryOptions = {
  queryKey: qkV2.pythHistory,
  queryFn: () => getPythHistory(PID, PYTH_FULL_POINTS),
  staleTime: 60_000,
  refetchOnWindowFocus: true,
};

/**
 * Warm the chart's history cache from page load, regardless of which hero tab is
 * showing, so switching to Chart paints the full window with little or no wait. Safe
 * to call from an always-mounted parent; it's a one-shot prefetch (dedupes with the
 * chart's own query by key, so there's never a double walk).
 */
export function usePrefetchPythHistory(): void {
  const qc = useQueryClient();
  useEffect(() => {
    // Seed first (cheap, paints fast if they switch immediately), then the deep walk.
    void qc.prefetchQuery(pythSeedQueryOptions);
    void qc.prefetchQuery(pythHistoryQueryOptions);
  }, [qc]);
}

/**
 * Cadence (ms) for the app-wide tape feeder, INCLUDING while the tab is hidden.
 * It has to stay comfortably under the charts' gap-break threshold: a stretch sampled
 * while the trader was away then still reads as one continuous (if slightly lower-
 * resolution) line instead of a break. Note that the interval is a floor, not the real
 * sampling rate — a `latest` read costs p50 ~420ms and p95 ~1.7s, so the tape actually
 * gains a point every ~3s here, which is what `GAP_BREAK_S` is sized against. Cheap to
 * run — `/api/v2/pyth?kind=latest` is CDN-cached at s-maxage=1, so every tab in the
 * world collapses into ~1 origin read per second no matter how many are polling.
 */
const TAPE_FEED_INTERVAL_MS = 2000;

/**
 * usePythTapeSpotFeed — the APP-WIDE half of the tape feed. Mount it ONCE from the
 * persistent chrome so the rolling buffer never stops accumulating.
 *
 * WHY IT'S SEPARATE FROM `usePythTapeFeed`: that one also runs the seed + full history
 * walks, which are far too expensive to hold open on every route. This one only rides
 * the pyth-latest read the nav spot tape is already polling, so it costs no extra
 * network — it just mirrors what lands into the tape.
 *
 * The two things it fixes, both of which used to punch a hole in the buffer that the
 * chart then drew as a break:
 *   1. Route changes — the tape used to be fed only by the trade/simple screens, so
 *      navigating to Portfolio and back left the buffer blind for the whole detour.
 *      The chrome outlives every /v2 route, so mounting it here closes that.
 *   2. Tab switches — React Query pauses `refetchInterval` while the tab is hidden, so
 *      an alt-tab blinded the buffer for as long as the trader was away. This query
 *      opts into `refetchIntervalInBackground` to keep sampling through it.
 *
 * Backfilling after the fact can't substitute for either: the event index trails live
 * by ~7s and the walk itself takes ~5s, so a hole is always visible for several seconds
 * before it heals. Not opening one is the only fix that holds.
 */
export function usePythTapeSpotFeed(): void {
  const { data } = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(PID),
    refetchInterval: TAPE_FEED_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  // In the foreground the nav tape polls this same key ~4x/s, so `data` still changes
  // at full resolution and this merges every one of those ticks; the interval above
  // only carries the buffer through the background stretch.
  useEffect(() => mergePythTape(data), [data]);
}

/**
 * Feed the rolling pyth-tape buffer ([[lib/store/pyth-tape]]) so it accumulates the
 * live price history EVEN WHILE the chart isn't mounted (the hero defaults to Surface).
 * Mount once from the always-mounted trade screen: it keeps the pyth-latest read stream-
 * fresh, and merges every live observation — plus the one-shot backfill — into the tape.
 * Switching to Chart then draws current history from the tape with no event walk.
 *
 * All three queries share keys with the chart's own (and the prefetch), so this adds no
 * extra network work — it's a pure observer that mirrors the data into the buffer.
 */
export function usePythTapeFeed(): void {
  useLivePyth(); // keep qkV2.pythLatest refreshing off the checkpoint stream while mounted
  const latest = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(PID),
    refetchInterval: 1500,
  });
  const seed = useQuery(pythSeedQueryOptions);
  const full = useQuery(pythHistoryQueryOptions);
  const latestData = latest.data;
  const seedData = seed.data;
  const fullData = full.data;
  // Mirror each source into the tape as it arrives (deduped per second inside merge).
  useEffect(() => mergePythTape(latestData), [latestData]);
  useEffect(() => mergePythTape(seedData), [seedData]);
  useEffect(() => mergePythTape(fullData), [fullData]);
}
