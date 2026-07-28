/**
 * lib/leaderboard/v2-onchain-store.ts — cache for the all-time Skew leaderboard.
 *
 * The GraphQL scan (fetchSkewLeaderboardRows) takes a few seconds, so we memoize its
 * result and refresh on a TTL. Two layers:
 *   1. an in-process snapshot on globalThis — the fast path within a warm instance;
 *   2. a durable KV snapshot (Upstash / Vercel KV) that bridges cold starts, so a
 *      fresh serverless instance serves the last scan instead of rescanning. Falls
 *      back to layer 1 only when no KV store is configured (local dev).
 *
 * A `pkg` guard (the predict package id) invalidates BOTH layers automatically on the
 * next migration/redeploy, so nothing needs a manual reset. Concurrent callers share
 * one in-flight scan, and any failure serves the last good board rather than erroring.
 */
import { predictV2Config } from '@/config/predict';
import { fetchSkewLeaderboardRows } from './v2-onchain-events';
import { kv } from '@/lib/server/kv';
import type { V2LeaderboardRow } from './v2';

/** Serve a snapshot without rescanning while it's younger than this. */
const FRESH_MS = 60_000;
/** How long the KV snapshot survives (bridges cold starts; self-expires after). */
const KV_TTL_S = 300;
const kvKey = () => `skew-board:${predictV2Config.packages.predict}`;

interface Snapshot {
  rows: V2LeaderboardRow[];
  builtAtMs: number;
  /** Predict package the snapshot was built against — the redeploy invalidation key. */
  pkg: string;
}

interface Cache {
  snap: Snapshot | null;
  inflight: Promise<Snapshot> | null;
}

const g = globalThis as unknown as { __skewBoard?: Cache };
const cache: Cache = (g.__skewBoard ??= { snap: null, inflight: null });

const forThisPkg = (s: Snapshot | null | undefined): s is Snapshot =>
  !!s && s.pkg === predictV2Config.packages.predict;
const isFresh = (s: Snapshot | null | undefined): s is Snapshot =>
  forThisPkg(s) && Date.now() - s.builtAtMs < FRESH_MS;

/** Scan the chain, cache in-process, and write through to KV (best-effort). */
async function scanAndStore(): Promise<Snapshot> {
  const rows = await fetchSkewLeaderboardRows();
  const snap: Snapshot = { rows, builtAtMs: Date.now(), pkg: predictV2Config.packages.predict };
  cache.snap = snap;
  if (kv) {
    try {
      await kv.set(kvKey(), snap, { ex: KV_TTL_S });
    } catch {
      /* KV write is best-effort — the in-process cache still serves this instance. */
    }
  }
  return snap;
}

export interface SkewBoardSnapshot {
  rows: V2LeaderboardRow[];
  builtAtMs: number;
  /** True when the fresh scan failed and we're serving the last good (or empty) board. */
  stale: boolean;
}

/**
 * The current Skew board. Serves the in-process snapshot when fresh, else a fresh KV
 * snapshot (no scan — this is what saves cold starts), else (re)builds with concurrent
 * callers sharing one scan. Never throws: on a scan failure it returns the last good
 * snapshot (in-process or KV, even if stale) or an empty board.
 */
export async function getSkewLeaderboardSnapshot(): Promise<SkewBoardSnapshot> {
  // 1. Warm in-process cache — the fast path within a live instance.
  if (isFresh(cache.snap)) {
    return { rows: cache.snap.rows, builtAtMs: cache.snap.builtAtMs, stale: false };
  }

  // 2. Durable KV — bridges cold starts. Adopt any snapshot for this package as the
  //    fallback, and serve it directly when it's still fresh (skips the scan).
  if (kv) {
    try {
      const cached = await kv.get<Snapshot>(kvKey());
      if (forThisPkg(cached)) {
        cache.snap = cached;
        if (isFresh(cached)) {
          return { rows: cached.rows, builtAtMs: cached.builtAtMs, stale: false };
        }
      }
    } catch {
      /* KV read failed — fall through to a live scan. */
    }
  }

  // 3. Nothing fresh anywhere — scan (concurrent callers share one), write through.
  cache.inflight ??= scanAndStore().finally(() => {
    cache.inflight = null;
  });
  try {
    const s = await cache.inflight;
    return { rows: s.rows, builtAtMs: s.builtAtMs, stale: false };
  } catch {
    const fallback = cache.snap;
    return { rows: fallback?.rows ?? [], builtAtMs: fallback?.builtAtMs ?? 0, stale: true };
  }
}
