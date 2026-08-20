'use client';

/**
 * use-spot-series — the ONE live BTC price series simple mode draws from.
 *
 * Every round on the simple screen is a bet on the same asset, so the hero chart and
 * every round card's sparkline are all views of a single history. This hook builds it
 * once, at the screen, and the pieces take it as a prop — a screen full of sparklines
 * then costs nothing extra and none of them can drift out of agreement with the chart.
 *
 * Sources, in the order they matter:
 *   - the rolling pyth-tape buffer, kept current app-wide (even across route changes
 *     and hidden tabs) by the chrome's feeder — this is what keeps the right-hand edge
 *     unbroken, since the history walk below is a ONE-SHOT that freezes at mount;
 *   - the seed + full history walks, for the cold-start backfill;
 *   - the live pyth read, for the leading tick.
 *
 * All three share query keys with the queries already running, so this adds no network
 * of its own, apart from the throttled hole-heal below. See [[lib/store/pyth-tape]] and
 * [[lib/hooks/use-v2-pyth-history]].
 */
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPythLatest, qkV2 } from '@/lib/api/v2/client';
import { pythSeedQueryOptions, pythHistoryQueryOptions } from '@/lib/hooks/use-v2-pyth-history';
import { getPythTape } from '@/lib/store/pyth-tape';
import { hasGapBefore, toSpotPoints, type SpotPoint } from '@/lib/charts/simple-series';
import { predictV2Config } from '@/config/predict';

const PID = predictV2Config.asset.pythFeedId;

/**
 * Hole-healing. The tape is built from polls, and a poll only ever carries ONE second's
 * price, so every slow round-trip leaves a second unlearned — measured on the running
 * app, gaps of 2-3s are constant even on a fast desktop connection (see `GAP_BREAK_S`).
 * Those seconds are not missing from the chain: a history walk over the same stretch
 * comes back with every one of them.
 *
 * So rather than drawing through a hole, ask for it. A gap wider than `HEAL_GAP_S` (set
 * clear of ordinary jitter, or this would re-walk forever) triggers one re-walk, at most
 * every `HEAL_THROTTLE_MS`, and the result merges into the tape as real observations.
 * The walk is CDN-cached for 10s, so concurrent traders collapse onto one origin read.
 */
const HEAL_GAP_S = 5;
const HEAL_THROTTLE_MS = 20_000;
/** The event index trails live by ~7s, so the newest seconds can't be healed — leave
 *  them to `GAP_BREAK_S`, which has the headroom to draw through them. */
const HEAL_EDGE_GUARD_S = 12;

/** Module-level, not per-hook: several screens can mount this, and the throttle is a
 *  budget on the shared endpoint rather than on any one component. */
let lastHealAt = 0;

export function useSpotSeries(windowS = 120): SpotPoint[] {
  const qc = useQueryClient();
  const seed = useQuery(pythSeedQueryOptions);
  const full = useQuery(pythHistoryQueryOptions);
  // No interval of its own: the nav spot tape drives this key ~4x/s from the always-
  // mounted chrome, so observing it is both free and as live as the app gets.
  const latest = useQuery({ queryKey: qkV2.pythLatest, queryFn: () => getPythLatest(PID) });

  const series = useMemo(() => {
    const history = full.data?.length ? full.data : (seed.data ?? []);
    // The tape isn't reactive, but `latest.data` changes on every tick and that is what
    // re-runs this — so the buffer is re-read at the live cadence.
    return toSpotPoints([...history, ...getPythTape(), ...(latest.data ? [latest.data] : [])], windowS);
  }, [full.data, seed.data, latest.data, windowS]);

  // Runs at the live cadence, but the throttle check short-circuits it to a subtraction
  // on all but one tick in twenty seconds.
  useEffect(() => {
    if (Date.now() - lastHealAt < HEAL_THROTTLE_MS) return;
    if (!hasGapBefore(series, HEAL_GAP_S, HEAL_EDGE_GUARD_S)) return;
    lastHealAt = Date.now();
    void qc.refetchQueries({ queryKey: pythHistoryQueryOptions.queryKey, exact: true });
  }, [series, qc]);

  return series;
}
