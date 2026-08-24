/**
 * lib/server/iv-store.ts — the accumulating implied-vol series.
 *
 * WHY THIS EXISTS AT ALL. Every other number on the Options page can be computed from
 * a single live read. "Is vol high or low right now" cannot: it needs a past, and the
 * v2 indexer publishes no SVI history. There is nothing to backfill from either, so
 * the series has to be grown forward from today. That is the whole job here.
 *
 * TWO LAYERS, same shape as lib/leaderboard/v2-onchain-store.ts:
 *   1. an in-process ring on globalThis, the fast path inside a warm instance;
 *   2. a durable KV blob that bridges cold starts and shares samples between
 *      instances. Without a KV store configured (local dev) layer 1 runs alone and
 *      the series simply resets with the process.
 *
 * A `pkg` guard (the predict package id) drops the whole series on a redeploy. That is
 * intentional and not a bug: a republished protocol is a different market, and ranking
 * today's vol against readings taken on a dead deployment would be worse than showing
 * nothing. Callers get an empty series and the rank stays hidden until it refills.
 *
 * SAMPLING IS READ-DRIVEN. There is no cron in this app, so a sample is recorded as a
 * side effect of the API route being read, at most once per SAMPLE_EVERY_MS. Visits
 * are uneven, so the series is unevenly spaced by construction, and everything
 * downstream treats it as a bag of observations rather than a time series: `ivRank`
 * takes a percentile, never a slope.
 */
import { predictV2Config } from '@/config/predict';
import { kv } from '@/lib/server/kv';
import type { IvSample } from '@/lib/insights/iv-history';

/** At most one sample this often, however many times the route is read. */
export const SAMPLE_EVERY_MS = 4 * 60_000;
/** Rolling retention. At one sample per 4 min this is about 5 days of dense history. */
export const MAX_SAMPLES = 1_800;
/** Samples older than this are dropped even if the ring is not full. */
export const MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Guards against a decode blip poisoning the series with an absurd reading. */
export const MIN_PLAUSIBLE_IV = 0.01;
export const MAX_PLAUSIBLE_IV = 10;

const kvKey = () => `skew-iv:${predictV2Config.packages.predict}`;
/** KV blob TTL. Longer than MAX_AGE_MS so retention is decided by us, not by expiry. */
const KV_TTL_S = 30 * 24 * 3_600;

interface Series {
  samples: IvSample[];
  pkg: string;
}

interface Cache {
  series: Series | null;
  /** Last KV read, so a burst of requests does not each hit the store. */
  loadedAtMs: number;
}

const g = globalThis as unknown as { __skewIv?: Cache };
const cache: Cache = (g.__skewIv ??= { series: null, loadedAtMs: 0 });

/** Serve the in-process copy without re-reading KV while it is younger than this. */
const CACHE_FRESH_MS = 30_000;

const forThisPkg = (s: Series | null | undefined): s is Series =>
  !!s && s.pkg === predictV2Config.packages.predict;

/** Drop anything stale or implausible and cap the ring. Oldest first. */
export function prune(samples: IvSample[], now: number): IvSample[] {
  return samples
    .filter(
      (s) =>
        Number.isFinite(s.tMs) &&
        Number.isFinite(s.iv) &&
        s.iv >= MIN_PLAUSIBLE_IV &&
        s.iv <= MAX_PLAUSIBLE_IV &&
        now - s.tMs <= MAX_AGE_MS &&
        s.tMs <= now + 60_000,
    )
    .sort((a, b) => a.tMs - b.tMs)
    .slice(-MAX_SAMPLES);
}

/** The stored series, from memory when warm, else KV. Never throws. */
export async function readSeries(now = Date.now()): Promise<IvSample[]> {
  if (forThisPkg(cache.series) && now - cache.loadedAtMs < CACHE_FRESH_MS) {
    return cache.series.samples;
  }
  let stored: Series | null = null;
  if (kv) {
    try {
      stored = (await kv.get<Series>(kvKey())) ?? null;
    } catch {
      /* KV read is best-effort — fall through to whatever this instance holds. */
    }
  }
  const samples = prune(forThisPkg(stored) ? stored.samples : (cache.series?.samples ?? []), now);
  cache.series = { samples, pkg: predictV2Config.packages.predict };
  cache.loadedAtMs = now;
  return samples;
}

export interface RecordResult {
  samples: IvSample[];
  /** True when this call actually appended (rather than being inside the interval). */
  recorded: boolean;
}

/**
 * Append `iv` if the newest sample is older than `SAMPLE_EVERY_MS`. Returns the series
 * either way, so a caller can read and record in one round trip.
 */
export async function recordSample(iv: number, now = Date.now()): Promise<RecordResult> {
  const samples = await readSeries(now);
  const usable = Number.isFinite(iv) && iv >= MIN_PLAUSIBLE_IV && iv <= MAX_PLAUSIBLE_IV;
  const newest = samples.length > 0 ? samples[samples.length - 1].tMs : -Infinity;
  if (!usable || now - newest < SAMPLE_EVERY_MS) return { samples, recorded: false };

  const next = prune([...samples, { tMs: now, iv }], now);
  cache.series = { samples: next, pkg: predictV2Config.packages.predict };
  cache.loadedAtMs = now;
  if (kv) {
    try {
      await kv.set(kvKey(), cache.series, { ex: KV_TTL_S });
    } catch {
      /* Best-effort — this instance still has the sample for its own lifetime. */
    }
  }
  return { samples: next, recorded: true };
}
