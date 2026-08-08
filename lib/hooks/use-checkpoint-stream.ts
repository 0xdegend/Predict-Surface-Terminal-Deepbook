'use client';

/**
 * use-checkpoint-stream — React glue over the shared gRPC checkpoint stream
 * ([[lib/sui/v2/checkpoint-stream]]).
 *
 * `useLivePyth()` is a side-effect hook: any component that shows the live spot
 * calls it, and together they keep ONE stream watch on the pyth feed alive (ref-
 * counted). When the feed writes on-chain, it invalidates the shared pyth-latest
 * query so the top tape + chart live-edge refresh within a checkpoint (~0.4s)
 * instead of on the next poll tick. Reads are still capped (~3/s) so a feed that
 * writes 4x/second can't turn into 4 reads/second.
 *
 * `useCheckpointStreamStatus()` exposes the stream's connection state so callers
 * (e.g. the spot query) can poll fast only while the stream is DOWN and back off to
 * a slow safety poll once it is live.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  watchObject,
  PYTH_FEED_OBJECT_ID,
  getStreamStatus,
  subscribeStreamStatus,
  type StreamStatus,
} from '@/lib/sui/v2/checkpoint-stream';
import { qkV2 } from '@/lib/api/v2/client';

/* ------------------------- shared live-pyth driver ------------------------ */
// N components watching spot must collapse to ONE stream watch + ONE debounce, so
// this driver is module-level and reference-counted across every useLivePyth mount.
let refCount = 0;
let unwatch: (() => void) | null = null;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;
let lastInvalidateAt = 0;

/** Floor between live reads (ms). The feed writes ~4x/s; we only need a few. */
const MIN_READ_INTERVAL_MS = 350;

function scheduleInvalidate(qc: QueryClient): void {
  const now = Date.now();
  const since = now - lastInvalidateAt;
  if (since >= MIN_READ_INTERVAL_MS) {
    lastInvalidateAt = now;
    void qc.invalidateQueries({ queryKey: qkV2.pythLatest });
    return;
  }
  if (trailingTimer) return; // a trailing refresh is already queued
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    lastInvalidateAt = Date.now();
    void qc.invalidateQueries({ queryKey: qkV2.pythLatest });
  }, MIN_READ_INTERVAL_MS - since);
}

/**
 * Keep the live spot fresh off the checkpoint stream while mounted. Side-effect only
 * (the spot value itself comes from `useV2Spot`'s query). Pass `enabled=false` to opt
 * out (e.g. on a deployment where the on-chain pyth read is not the spot source).
 */
export function useLivePyth(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    refCount += 1;
    if (!unwatch) {
      unwatch = watchObject(PYTH_FEED_OBJECT_ID, () => scheduleInvalidate(qc));
    }
    return () => {
      refCount -= 1;
      if (refCount <= 0) {
        refCount = 0;
        unwatch?.();
        unwatch = null;
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
      }
    };
  }, [enabled, qc]);
}

/* --------------------- generic "refresh on pyth" nudge -------------------- */

/**
 * Refresh an arbitrary query whenever the pyth feed writes on-chain, capped at one
 * refresh per `minIntervalMs`. Use for reads that should track the price but are too
 * heavy to run on every tick (e.g. the pricer/odds simulate). Unlike `useLivePyth`
 * this is per-mount (the key varies), so keep `minIntervalMs` conservative.
 */
export function useLiveRefreshOnPyth(
  queryKey: readonly unknown[],
  minIntervalMs: number,
  enabled = true,
): void {
  const qc = useQueryClient();
  const keyStr = JSON.stringify(queryKey);
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      last = Date.now();
      void qc.invalidateQueries({ queryKey: JSON.parse(keyStr) as unknown[] });
    };
    const unwatch = watchObject(PYTH_FEED_OBJECT_ID, () => {
      const since = Date.now() - last;
      if (since >= minIntervalMs) {
        fire();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          fire();
        }, minIntervalMs - since);
      }
    });
    return () => {
      unwatch();
      if (timer) clearTimeout(timer);
    };
    // keyStr captures queryKey by value; qc is stable.
  }, [keyStr, minIntervalMs, enabled, qc]);
}

/* ----------------------------- stream status ------------------------------ */

/** The shared checkpoint stream's connection status, re-rendering on change. */
export function useCheckpointStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStreamStatus, getStreamStatus, () => 'idle' as StreamStatus);
}
