/**
 * lib/api/v2/analytics-demo.ts — SAMPLE analytics data for the v2 Analytics page.
 *
 * Testnet flow is sparse and the GLOBAL feed endpoints (/positions/minted,
 * /trades, sentiment, leaderboard) aren't indexed yet, so the activity views
 * would otherwise render as a wall of zeros. These deterministic generators
 * produce realistic sample flow — a live trade tape, UP/DOWN sentiment, a 24h
 * activity trend, top markets, and rollup totals — so the page previews what
 * the analytics look like with real volume.
 *
 * ALWAYS shown behind an explicit "Sample data" label (never passed off as live).
 * Pure + seeded so a server render is stable within a request; swap each
 * generator for its real endpoint once the indexer exposes global flow.
 */
import type { V2Market } from './types';
import { cadenceOf, type V2Cadence } from '@/lib/markets/v2-discovery';

/* --------------------------- seeded PRNG (mulberry32) -------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable per-hour seed so the sample data holds steady for a while, then drifts. */
export function hourlySeed(now = Date.now()): number {
  return Math.floor(now / 3_600_000);
}

/** A ready-to-use PRNG (client tickers seed it from the wall clock). */
export function makeRng(seed = Date.now()): () => number {
  return mulberry32(seed >>> 0);
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const between = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);
const round2 = (n: number) => Math.round(n * 100) / 100;

const HEX = '0123456789abcdef';
/** A deterministic 0x… address so avatars/short-ids stay stable per sample bet. */
function fakeAddress(rng: () => number): string {
  let s = '0x';
  for (let i = 0; i < 40; i++) s += HEX[Math.floor(rng() * 16)];
  return s;
}

/* -------------------------------- flow tape -------------------------------- */

export type DemoSide = 'up' | 'down' | 'range';

export interface DemoFlowRow {
  id: string;
  tsMs: number; // when the bet landed
  trader: string; // 0x… (sample) — for the avatar + short id
  cadence: V2Cadence;
  side: DemoSide;
  stakeUsd: number;
  payoutUsd: number;
  leverage: number;
}

// 1-minute markets churn the most bets, hourly the fewest.
const CADENCE_WEIGHTS: [V2Cadence, number][] = [
  ['1m', 0.6],
  ['5m', 0.3],
  ['1h', 0.1],
];
function weightedCadence(rng: () => number): V2Cadence {
  let r = rng();
  for (const [c, w] of CADENCE_WEIGHTS) {
    if (r < w) return c;
    r -= w;
  }
  return '1h';
}

/** One sample bet, `agoMs` before `now`. */
export function makeFlowRow(rng: () => number, now: number, agoMs: number): DemoFlowRow {
  const side: DemoSide = rng() < 0.46 ? 'up' : rng() < 0.85 ? 'down' : 'range';
  const stakeUsd = round2(pick(rng, [1, 2, 5, 5, 10, 10, 25, 50, 100, 250]) * between(rng, 0.8, 1.2));
  const mult = side === 'range' ? between(rng, 1.6, 5) : between(rng, 1.1, 6.5);
  const leverage = side === 'range' ? 1 : pick(rng, [1, 1, 1, 2, 2, 3]);
  return {
    id: `${now - agoMs}-${Math.floor(rng() * 1e6)}`,
    tsMs: now - agoMs,
    trader: fakeAddress(rng),
    cadence: weightedCadence(rng),
    side,
    stakeUsd,
    payoutUsd: round2(stakeUsd * mult),
    leverage,
  };
}

/** `count` recent sample bets, newest first, spread over the last ~12 minutes. */
export function demoFlowRows(count = 14, now = Date.now(), seed = hourlySeed(now)): DemoFlowRow[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const rows: DemoFlowRow[] = [];
  let ago = Math.floor(between(rng, 1_000, 6_000));
  for (let i = 0; i < count; i++) {
    rows.push(makeFlowRow(rng, now, ago));
    ago += Math.floor(between(rng, 4_000, 60_000));
  }
  return rows;
}

/* ------------------------------- sentiment -------------------------------- */

export interface DemoSentiment {
  upCost: number;
  downCost: number;
  upCount: number;
  downCount: number;
  upShare: number;
  totalCost: number;
}

export function demoSentiment(now = Date.now(), seed = hourlySeed(now)): DemoSentiment {
  const rng = mulberry32(seed ^ 0x85ebca6b);
  const upShare = between(rng, 0.4, 0.62); // usually a mild lean
  const totalCost = round2(between(rng, 4_000, 16_000));
  const upCost = round2(totalCost * upShare);
  const downCost = round2(totalCost - upCost);
  const totalCount = Math.floor(between(rng, 120, 420));
  const upCount = Math.floor(totalCount * upShare);
  return { upCost, downCost, upCount, downCount: totalCount - upCount, upShare, totalCost };
}

/* ------------------------------ IV history -------------------------------- */

/** A short expected-swing (ATM IV) history ending near `latest`, for the Price-
 *  swing sparkline. A gentle mean-reverting wobble around the current level. */
export function demoIvSeries(latest: number, count = 40, seed = hourlySeed()): number[] {
  const rng = mulberry32(seed ^ 0xc2b2ae35);
  const out: number[] = [];
  let v = latest * between(rng, 0.85, 1.05);
  for (let i = 0; i < count; i++) {
    v += (latest - v) * 0.12 + (rng() - 0.5) * latest * 0.05;
    out.push(Math.max(0.01, v));
  }
  out[out.length - 1] = latest; // land exactly on the displayed value
  return out;
}

/* ------------------------------ market cells ------------------------------ */

/** A per-market analytics row — the real market + sample metrics. Mirrors the
 *  legacy `MarketCell` fields the Pulse/Markets/Sentiment tools read. */
export interface DemoMarketCell {
  market: V2Market;
  marketId: string;
  cadence: V2Cadence;
  expiry: number;
  forward: number; // ≈ live spot (real when a spot is passed in)
  atmIv: number; // expected-swing % (sample)
  volume: number; // DUSDC bet (sample)
  oi: number; // open positions (sample)
  bets: number; // mints (sample)
  upShare: number; // crowd lean 0..1 (sample)
}

const DEFAULT_SPOT = 63_000;

/** Sample metrics over the REAL live markets, ranked by volume desc. `spot`
 *  (live BTC) makes each market's forward realistic; IV shrinks with tenor. */
export function demoMarketCells(
  markets: V2Market[],
  spot: number | null,
  now = Date.now(),
  seed = hourlySeed(now),
): DemoMarketCell[] {
  const rng = mulberry32(seed ^ 0x27d4eb2f);
  const base = spot ?? DEFAULT_SPOT;
  return markets
    .map((market) => {
      const cadence = cadenceOf(market);
      const tenorMin = Math.max(0.5, (market.expiry - now) / 60_000);
      // Faster cadences: more, smaller bets. Longer tenor: bigger expected swing.
      const vol = cadence === '1m' ? between(rng, 900, 2600) : cadence === '5m' ? between(rng, 500, 1600) : between(rng, 200, 900);
      const atmIv = between(rng, 0.18, 0.34) * Math.min(1.8, 0.6 + tenorMin / 90);
      return {
        market,
        marketId: market.expiry_market_id,
        cadence,
        expiry: market.expiry,
        forward: round2(base * between(rng, 0.9995, 1.0005)),
        atmIv,
        volume: round2(vol),
        oi: Math.floor(between(rng, 4, 60)),
        bets: Math.floor(between(rng, 20, 240)),
        upShare: between(rng, 0.32, 0.68),
      };
    })
    .sort((a, b) => b.volume - a.volume);
}

/* --------------------------------- KPIs ----------------------------------- */

export interface DemoKpis {
  totalBet: number; // DUSDC bet, last hour
  activeMarkets: number; // REAL count
  upShare: number; // crowd lean 0..1
  biggestBet: number; // DUSDC
}

/** Top-line KPI reads for the Pulse strip, agreeing with the cells on the page. */
export function demoKpis(cells: DemoMarketCell[], activeMarkets: number, now = Date.now(), seed = hourlySeed(now)): DemoKpis {
  const rng = mulberry32(seed ^ 0x1b56c4e9);
  const totalBet = round2(cells.reduce((s, c) => s + c.volume, 0));
  const upWeighted = cells.reduce((s, c) => s + c.upShare * c.volume, 0);
  const upShare = totalBet > 0 ? upWeighted / totalBet : 0.5;
  return {
    totalBet,
    activeMarkets,
    upShare,
    biggestBet: round2(between(rng, 180, 620)),
  };
}
