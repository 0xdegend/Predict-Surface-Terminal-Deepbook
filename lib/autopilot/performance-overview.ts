/**
 * Performance overview — the landing page's "how has Autopilot done" block, as pure data.
 *
 * Everything here is derived from the saved Results archive (every settled trade of every
 * finished run), windowed to a range the trader picks: today, the last week, the last
 * month, or everything. The component only draws what comes out of here, so the numbers
 * and the axis are unit-tested and the drawing code stays about drawing.
 *
 * Two shapes come out. `overviewStats` is the KPI row (P&L, trades, win rate, best
 * streak, max drawdown). `overviewSeries` is the chart: cumulative P&L across the range
 * with the x axis in time and a symmetric y axis that always includes zero, so a flat
 * day still draws as a baseline with room either side rather than a collapsed line.
 */
import { buildEquityCurve, type EquityTrade } from './equity';

export type OverviewRange = '1D' | '7D' | '30D' | 'ALL';

export const OVERVIEW_RANGES: readonly OverviewRange[] = ['1D', '7D', '30D', 'ALL'];

const DAY_MS = 24 * 60 * 60_000;

/** Local midnight of the day `now` falls in. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The window a range covers, as [start, end] in ms. Today runs midnight to midnight so
 * the axis reads 00:00 to 24:00 and a trade at 09:14 sits where the clock says it does.
 * The week and month run back from now. ALL fits the trades themselves (with a day of
 * fallback room when there are none), so the whole record fills the width.
 */
export function rangeWindow(range: OverviewRange, now: number, trades: readonly EquityTrade[] = []): [number, number] {
  switch (range) {
    case '1D': {
      const s = startOfDay(now);
      return [s, s + DAY_MS];
    }
    case '7D':
      return [now - 7 * DAY_MS, now];
    case '30D':
      return [now - 30 * DAY_MS, now];
    case 'ALL': {
      const settled = trades.filter(isSettled);
      if (settled.length === 0) return [now - DAY_MS, now];
      let lo = Infinity;
      let hi = -Infinity;
      for (const t of settled) {
        if (t.at < lo) lo = t.at;
        if (t.at > hi) hi = t.at;
      }
      // A single trade (or several in one minute) needs some width to sit in.
      if (hi - lo < 60_000) return [lo - 30 * 60_000, hi + 30 * 60_000];
      return [lo, Math.max(hi, now)];
    }
  }
}

const isSettled = (t: EquityTrade) => t.outcome === 'won' || t.outcome === 'lost';

/** The settled trades inside a window, oldest first. */
export function tradesInWindow(trades: readonly EquityTrade[], [start, end]: [number, number]): EquityTrade[] {
  return trades.filter((t) => isSettled(t) && t.at >= start && t.at <= end).sort((a, b) => a.at - b.at);
}

export interface OverviewStats {
  pnlUsd: number;
  trades: number;
  wins: number;
  losses: number;
  /** 0..1, or null with nothing settled. */
  winRate: number | null;
  /** The longest run of consecutive wins in the window. */
  bestStreak: number;
  /** Worst peak-to-trough fall of the running total, as a positive number. */
  maxDrawdown: number;
}

export function overviewStats(trades: readonly EquityTrade[], range: OverviewRange, now: number): OverviewStats {
  const inWin = tradesInWindow(trades, rangeWindow(range, now, trades));
  let wins = 0;
  let losses = 0;
  let pnlUsd = 0;
  let streak = 0;
  let bestStreak = 0;
  for (const t of inWin) {
    pnlUsd += t.pnlUsd;
    if (t.outcome === 'won') {
      wins++;
      streak++;
      if (streak > bestStreak) bestStreak = streak;
    } else {
      losses++;
      streak = 0;
    }
  }
  const resolved = wins + losses;
  return {
    pnlUsd,
    trades: inWin.length,
    wins,
    losses,
    winRate: resolved > 0 ? wins / resolved : null,
    bestStreak,
    maxDrawdown: buildEquityCurve(inWin).maxDrawdown,
  };
}

export interface OverviewPoint {
  /** 0..1 across the window. */
  x: number;
  /** Cumulative P&L (USD) after the trade at this point. */
  y: number;
}

export interface OverviewSeries {
  points: OverviewPoint[];
  /** The y axis runs -yMax..yMax. */
  yMax: number;
  /** Top, zero, bottom labels. */
  ticksY: { value: number; label: string }[];
  /** Time labels with their 0..1 position. */
  ticksX: { x: number; label: string }[];
  window: [number, number];
}

/**
 * The next "round" number at or above `v`: 1, 2, 5 times a power of ten. A y axis that
 * tops out at exactly the biggest swing puts the line on the frame; rounding up gives it
 * headroom and a label a person can read.
 */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 0;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * base;
}

/** 1250 → "1.3K", 500 → "500", -1000 → "-1.0K", 0 → "0". Axis labels, not money. */
export function fmtAxis(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(1)}K`;
  return `${sign}${Math.round(a)}`;
}

/** Empty ranges still get a readable axis: this is what ±1.0K on a fresh page is. */
const EMPTY_Y_MAX = 1000;

/** How much of the window a settlement takes to "arrive" on the curve (see the lead-in
 *  points in overviewSeries). About 20 minutes of a day, 2.5 hours of a week. */
export const SETTLE_EASE = 0.015;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function timeLabel(ms: number, range: OverviewRange, end: number): string {
  const d = new Date(ms);
  switch (range) {
    case '1D':
      // 24:00 for the right edge (it IS midnight, but the next day's 00:00 reads wrong).
      return ms >= end ? '24:00' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    case '7D':
      return DAY_NAMES[d.getDay()];
    default:
      return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  }
}

function xTicks(range: OverviewRange, [start, end]: [number, number]): { x: number; label: string }[] {
  const span = end - start || 1;
  const at = (ms: number) => ({ x: (ms - start) / span, label: timeLabel(ms, range, end) });
  if (range === '1D') {
    // 00:00, 04:00 ... 24:00, the same seven the clock face reads.
    return Array.from({ length: 7 }, (_, i) => at(start + (i * DAY_MS) / 6));
  }
  if (range === '7D') {
    // One per day, at that day's midnight, so the label sits where the day starts.
    const out: { x: number; label: string }[] = [];
    for (let s = startOfDay(start) + DAY_MS; s <= end; s += DAY_MS) out.push(at(s));
    return out;
  }
  // Month and ALL: six evenly spaced dates across the window.
  return Array.from({ length: 6 }, (_, i) => at(start + (i * span) / 5));
}

export function overviewSeries(trades: readonly EquityTrade[], range: OverviewRange, now: number): OverviewSeries {
  const window = rangeWindow(range, now, trades);
  const [start, end] = window;
  const span = end - start || 1;
  const inWin = tradesInWindow(trades, window);

  // One point per settled trade (the running total after it, at the time it settled),
  // each with a short LEAD-IN just before it holding the previous level. The chart draws
  // the list as a monotone curve (lib/autopilot/smooth-path), and the lead-in is what
  // keeps that curve honest about time: without it, a single trade a day into a
  // week-long window drew as a six-day slope from the window's edge, a slow bleed that
  // never happened. With it, the line holds flat until a settlement and eases into the
  // new level over about a percent and a half of the window. Trades closer together
  // than that flow into one another with no lead-in, which is the right picture of a
  // burst of settlements.
  const points: OverviewPoint[] = [{ x: 0, y: 0 }];
  let cum = 0;
  let swing = 0;
  let lastX = 0;
  for (const t of inWin) {
    const x = (t.at - start) / span;
    const lead = x - SETTLE_EASE;
    if (lead > lastX) points.push({ x: lead, y: cum });
    cum += t.pnlUsd;
    if (Math.abs(cum) > swing) swing = Math.abs(cum);
    points.push({ x, y: cum });
    lastX = x;
  }
  // Carry the line to the right edge so "where it stands now" reads across the chart.
  // Today's window runs to midnight, so the carry stops at now rather than the frame.
  const edge = Math.min(1, Math.max(points[points.length - 1].x, (Math.min(now, end) - start) / span));
  if (edge > points[points.length - 1].x) points.push({ x: edge, y: cum });

  const yMax = swing > 0 ? niceCeil(swing * 1.15) : EMPTY_Y_MAX;
  return {
    points,
    yMax,
    ticksY: [yMax, 0, -yMax].map((value) => ({ value, label: fmtAxis(value) })),
    ticksX: xTicks(range, window),
    window,
  };
}
