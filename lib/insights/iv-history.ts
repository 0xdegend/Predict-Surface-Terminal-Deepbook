/**
 * lib/insights/iv-history.ts — is today's implied vol high or low FOR THIS MARKET?
 *
 * The page could print "ATM IV 71%" from the first day it existed, and that number on
 * its own carries almost no information. 71% is alarming for one asset and a sleepy
 * afternoon for another, and a trader's actual question is always relative: high or
 * low compared with what this market has been doing lately. Answering it needs a
 * history, and the v2 indexer publishes none (there is no SVI history endpoint), so
 * the series has to be accumulated forward. See lib/server/iv-store.ts.
 *
 * CONSTANT MATURITY, NOT "THE FRONT MARKET". Sampling whichever expiry happens to be
 * nearest would produce a series dominated by time-to-expiry rather than by the
 * market: a one-minute round's ATM vol behaves nothing like an hourly's, and stitching
 * them together makes a chart that mostly measures which market existed when. So each
 * sample is the ATM vol interpolated to a FIXED tenor, the way VIX is quoted at a
 * constant 30 days. Interpolation is linear in TOTAL VARIANCE against time, which is
 * the arbitrage-consistent thing to do (a calendar spread priced off a linear-in-sigma
 * interpolation can be negative; linear in w cannot).
 *
 * Pure and side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */

/** One expiry's at-the-money read. */
export interface AtmPoint {
  /** Time to expiry in years. Must be > 0. */
  tYears: number;
  /** At-the-money implied vol (annualized, 0.71 = 71%). */
  atmIv: number;
}

/** The tenor the series is quoted at. One hour: long enough to be stable, short
 *  enough that our live expiries actually bracket it most of the time. */
export const CONSTANT_TENOR_HOURS = 1;
export const CONSTANT_TENOR_YEARS = CONSTANT_TENOR_HOURS / (365 * 24);

/** Samples needed before a rank is worth showing. Below this it is an anecdote. */
export const MIN_RANK_SAMPLES = 12;
/** History shorter than this is not a useful comparison, however many samples. */
export const MIN_RANK_SPAN_MS = 45 * 60_000;

/**
 * ATM vol at a fixed tenor, interpolated across the live expiries in total-variance
 * space. Returns null with nothing usable to interpolate from.
 *
 * Outside the range of live expiries this holds the nearest expiry's VOL flat rather
 * than extrapolating variance, which would fabricate a term structure we cannot see.
 */
export function constantMaturityAtmIv(points: AtmPoint[], targetYears = CONSTANT_TENOR_YEARS): number | null {
  const pts = points
    .filter((p) => Number.isFinite(p.tYears) && p.tYears > 0 && Number.isFinite(p.atmIv) && p.atmIv > 0)
    .sort((a, b) => a.tYears - b.tYears);
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0].atmIv;
  if (targetYears <= pts[0].tYears) return pts[0].atmIv;
  if (targetYears >= pts[pts.length - 1].tYears) return pts[pts.length - 1].atmIv;

  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i];
    const hi = pts[i + 1];
    if (targetYears >= lo.tYears && targetYears <= hi.tYears) {
      const wLo = lo.atmIv * lo.atmIv * lo.tYears;
      const wHi = hi.atmIv * hi.atmIv * hi.tYears;
      const span = hi.tYears - lo.tYears;
      const u = span > 0 ? (targetYears - lo.tYears) / span : 0;
      const w = wLo + (wHi - wLo) * u;
      return w > 0 ? Math.sqrt(w / targetYears) : null;
    }
  }
  return null;
}

/** One accumulated observation. */
export interface IvSample {
  /** When it was taken (ms epoch). */
  tMs: number;
  /** Constant-maturity ATM vol at that moment. */
  iv: number;
}

export type IvBand = 'unusually calm' | 'calm' | 'normal' | 'busy' | 'unusually busy';

export interface IvRank {
  /** The reading being ranked. */
  iv: number;
  low: number;
  high: number;
  median: number;
  /** Share of observations at or below `iv` (0..1). */
  percentile: number;
  samples: number;
  /** Oldest to newest, in ms. */
  spanMs: number;
  band: IvBand;
  /** One plain sentence. */
  summary: string;
}

const BANDS: { at: number; band: IvBand }[] = [
  { at: 0.1, band: 'unusually calm' },
  { at: 0.3, band: 'calm' },
  { at: 0.7, band: 'normal' },
  { at: 0.9, band: 'busy' },
  { at: 1.01, band: 'unusually busy' },
];

export function ivBand(percentile: number): IvBand {
  return BANDS.find((b) => percentile < b.at)?.band ?? 'unusually busy';
}

/**
 * Where `current` sits in the accumulated history. Null until there is enough history
 * to mean anything, because a percentile computed from four readings taken over ten
 * minutes is a number pretending to be a measurement.
 */
export function ivRank(samples: IvSample[], current: number): IvRank | null {
  if (!(current > 0)) return null;
  const clean = samples
    .filter((s) => Number.isFinite(s.iv) && s.iv > 0 && Number.isFinite(s.tMs))
    .sort((a, b) => a.tMs - b.tMs);
  if (clean.length < MIN_RANK_SAMPLES) return null;

  const spanMs = clean[clean.length - 1].tMs - clean[0].tMs;
  if (spanMs < MIN_RANK_SPAN_MS) return null;

  const ivs = clean.map((s) => s.iv).sort((a, b) => a - b);
  const low = ivs[0];
  const high = ivs[ivs.length - 1];
  const median = ivs[Math.floor(ivs.length / 2)];
  const atOrBelow = ivs.filter((v) => v <= current).length;
  const percentile = atOrBelow / ivs.length;
  const band = ivBand(percentile);

  return {
    iv: current,
    low,
    high,
    median,
    percentile,
    samples: ivs.length,
    spanMs,
    band,
    summary: summarize(current, percentile, band, spanMs),
  };
}

function summarize(iv: number, percentile: number, band: IvBand, spanMs: number): string {
  const pct = Math.round(iv * 100);
  const rank = Math.round(percentile * 100);
  const over = spanWords(spanMs);

  if (band === 'normal') {
    return `At ${pct}%, about where this market usually sits over the last ${over}.`;
  }
  const side = percentile >= 0.5 ? 'higher' : 'lower';
  const emphasis = band.startsWith('unusually') ? ' That is a long way from normal.' : '';
  return `At ${pct}%, ${side} than ${percentile >= 0.5 ? rank : 100 - rank}% of the last ${over}.${emphasis}`;
}

function spanWords(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1.5) return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (h < 36) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}
