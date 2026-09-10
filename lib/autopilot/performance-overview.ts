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
 * with the x axis in time and a zero-anchored y axis fit to the data's real span (not
 * forced symmetric), so a loss-heavy run uses the room below zero instead of hugging the
 * centre. Today's x axis frames to the session's activity rather than the full 24h clock,
 * so a few hours of trading fill the width instead of drawing as a flat day with a spike.
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
 * The window a range covers, as [start, end] in ms. Today (1D) frames to the day's
 * activity when it has any (a little before the first settlement to a little past the
 * last, or now), so a clustered session fills the width; an empty day falls back to the
 * full 00:00-24:00 clock. The week and month run back from now. ALL fits the trades
 * themselves (with a day of fallback room when there are none), so the whole record
 * fills the width.
 */
export function rangeWindow(range: OverviewRange, now: number, trades: readonly EquityTrade[] = []): [number, number] {
  switch (range) {
    case '1D': {
      // Frame today to its ACTIVITY, not the wall clock. A session that ran a few evening
      // hours used to draw as a flat morning with a spike jammed into the last fifth,
      // because cumulative P&L only moves when a trade settles. Now the window runs from a
      // little before the first settlement to a little past the last (or now), so the curve
      // fills the width and clustered wins read as a slope, not a cliff. An empty day keeps
      // the full clock so it still reads as "today".
      const dayStart = startOfDay(now);
      const dayEnd = dayStart + DAY_MS;
      const today = trades.filter((t) => isSettled(t) && t.at >= dayStart && t.at < dayEnd);
      if (today.length === 0) return [dayStart, dayEnd];
      let first = Infinity;
      let last = -Infinity;
      for (const t of today) {
        if (t.at < first) first = t.at;
        if (t.at > last) last = t.at;
      }
      const spanTrades = Math.max(last - first, 30 * 60_000); // a single trade still gets width
      const pad = Math.max(30 * 60_000, spanTrades * 0.1);
      return [Math.max(dayStart, first - pad), Math.min(dayEnd, Math.max(last, now) + pad * 0.5)];
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
  /** The y axis runs yBottom..yTop, fit to the data's real span and NOT forced
   *  symmetric: a loss-heavy run gets more room below zero than above, so the line fills
   *  the plot instead of hugging the centre. Both are zero-anchored: yTop >= 0 >= yBottom. */
  yTop: number;
  yBottom: number;
  /** Top, zero, bottom labels (values yTop, 0, yBottom). */
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

/**
 * Round UP to a nice number on a finer ladder than niceCeil, and always strictly above
 * `v` so the line never sits on the frame. This is what fits ONE side of the axis to the
 * data: niceCeil's 1/2/5/10 ladder jumps 5.8K straight to 10K (a 70% overshoot that
 * crushes the curve), where this lands on 6K. Used only for the axis domain; niceCeil
 * stays as-is for anything that depends on its coarser rounding.
 */
export function niceBound(v: number): number {
  if (!(v > 0)) return 0;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s > m) ?? 10;
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
    // A full-day window (the empty state) keeps the seven clock marks 00:00..24:00.
    if (end - start >= DAY_MS - 1) {
      return Array.from({ length: 7 }, (_, i) => at(start + (i * DAY_MS) / 6));
    }
    // A framed-to-activity window gets adaptive clock ticks: pick a step (15m..6h) that
    // yields a handful of marks, aligned to the local clock, labelled HH:MM.
    const base = startOfDay(start);
    const steps = [15, 30, 60, 120, 180, 240, 360].map((m) => m * 60_000);
    const step = steps.find((s) => span / s <= 6) ?? steps[steps.length - 1];
    const firstTick = base + Math.ceil((start - base) / step) * step;
    const out: { x: number; label: string }[] = [];
    for (let ms = firstTick; ms <= end + 1; ms += step) {
      const d = new Date(ms);
      out.push({ x: (ms - start) / span, label: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` });
    }
    return out;
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

  // Fit the axis to the curve's real span, zero-anchored and NOT symmetric, so a run that
  // spent the week underwater uses the room below zero rather than being crushed into a
  // thin band under the centre line (which is how a -5.8K drawdown drew as a near-flat
  // line on a forced +/-10K axis). Each side rounds up to a nice number for its label.
  //
  // The `floor` keeps the QUIET side of a lopsided run from collapsing: when one late
  // move dwarfs everything (a flat day, then a +6.7K spike), the tiny opposite side would
  // otherwise sit a hair off the frame and jam the flat stretch against the edge. Giving
  // the smaller side at least a sixth of the dominant side lifts zero clear so that
  // stretch, and its small dips, have room to read.
  let yTop: number;
  let yBottom: number;
  if (swing > 0) {
    let hi = 0;
    let lo = 0;
    for (const p of points) {
      if (p.y > hi) hi = p.y;
      if (p.y < lo) lo = p.y;
    }
    const rawTop = niceBound(hi);
    const rawBot = niceBound(-lo);
    const floor = Math.max(rawTop, rawBot) * 0.15;
    yTop = Math.max(rawTop, floor);
    yBottom = -Math.max(rawBot, floor);
  } else {
    yTop = EMPTY_Y_MAX;
    yBottom = -EMPTY_Y_MAX;
  }
  return {
    points,
    yTop,
    yBottom,
    ticksY: [yTop, 0, yBottom].map((value) => ({ value, label: fmtAxis(value) })),
    ticksX: xTicks(range, window),
    window,
  };
}
