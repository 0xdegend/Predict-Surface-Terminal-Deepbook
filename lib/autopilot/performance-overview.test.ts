import { describe, it, expect } from 'vitest';
import { fmtAxis, niceCeil, overviewSeries, overviewStats, rangeWindow, startOfDay, tradesInWindow } from './performance-overview';
import type { EquityTrade } from './equity';

const H = 60 * 60_000;
const D = 24 * H;
// A fixed "now" mid-afternoon so today's window has room on both sides.
const NOW = startOfDay(1_800_000_000_000) + 15 * H;

const t = (agoMs: number, pnlUsd: number, outcome: EquityTrade['outcome'] = pnlUsd >= 0 ? 'won' : 'lost'): EquityTrade => ({
  at: NOW - agoMs,
  pnlUsd,
  outcome,
});

describe('rangeWindow', () => {
  it('today runs midnight to midnight, the week and month run back from now', () => {
    const [s, e] = rangeWindow('1D', NOW);
    expect(s).toBe(startOfDay(NOW));
    expect(e - s).toBe(D);
    expect(rangeWindow('7D', NOW)).toEqual([NOW - 7 * D, NOW]);
    expect(rangeWindow('30D', NOW)).toEqual([NOW - 30 * D, NOW]);
  });

  it('ALL fits the trades, with a day of room when there are none', () => {
    expect(rangeWindow('ALL', NOW, [])).toEqual([NOW - D, NOW]);
    const [s, e] = rangeWindow('ALL', NOW, [t(10 * D, 1), t(2 * D, -1)]);
    expect(s).toBe(NOW - 10 * D);
    expect(e).toBe(NOW);
  });
});

describe('overviewStats', () => {
  const trades = [t(20 * H, 3), t(10 * H, 4), t(2 * H, -5), t(1 * H, 2), t(3 * D, 10), t(40 * D, -20)];

  it('windows to the range and counts wins, losses, and the best streak', () => {
    const day = overviewStats(trades, '1D', NOW);
    expect(day.trades).toBe(3); // the 20h-ago one is yesterday
    expect(day.pnlUsd).toBe(1);
    expect(day.wins).toBe(2);
    expect(day.losses).toBe(1);
    expect(day.winRate).toBeCloseTo(2 / 3);
    expect(day.bestStreak).toBe(1);

    const week = overviewStats(trades, '7D', NOW);
    expect(week.trades).toBe(5);
    expect(week.bestStreak).toBe(3); // 10, 3, 4 in a row before the -5
    expect(week.maxDrawdown).toBe(5);

    const all = overviewStats(trades, 'ALL', NOW);
    expect(all.trades).toBe(6);
    expect(all.pnlUsd).toBe(-6);
  });

  it('is empty-safe', () => {
    const s = overviewStats([], '1D', NOW);
    expect(s).toEqual({ pnlUsd: 0, trades: 0, wins: 0, losses: 0, winRate: null, bestStreak: 0, maxDrawdown: 0 });
  });

  it('leaves pending trades out rather than counting them as break-even', () => {
    expect(tradesInWindow([t(1 * H, 0, 'pending'), t(2 * H, 5)], rangeWindow('1D', NOW))).toHaveLength(1);
  });
});

describe('overviewSeries', () => {
  it('draws a flat baseline with a readable ±1.0K axis when there is nothing yet', () => {
    const s = overviewSeries([], '1D', NOW);
    expect(s.yMax).toBe(1000);
    expect(s.ticksY.map((k) => k.label)).toEqual(['1.0K', '0', '-1.0K']);
    expect(s.points[0]).toEqual({ x: 0, y: 0 });
    // Carried to "now" (15:00 of a 24h day), not to the frame's right edge.
    expect(s.points[s.points.length - 1].x).toBeCloseTo(15 / 24);
    expect(s.points.every((p) => p.y === 0)).toBe(true);
  });

  it('steps at each settlement (flat before, jump at the trade) with headroom above the biggest swing', () => {
    const s = overviewSeries([t(10 * H, 300), t(2 * H, -500)], '1D', NOW);
    expect(s.points.map((p) => p.y)).toEqual([0, 0, 300, 300, -200, -200]);
    // The first trade at 05:00 contributes two points at the same x: before and after.
    expect(s.points[1].x).toBeCloseTo(5 / 24);
    expect(s.points[2].x).toBeCloseTo(5 / 24);
    expect(s.yMax).toBe(500); // niceCeil(300 * 1.15) = 500
  });

  it('labels today 00:00 through 24:00 in four-hour steps', () => {
    const s = overviewSeries([], '1D', NOW);
    expect(s.ticksX.map((k) => k.label)).toEqual(['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00']);
    expect(s.ticksX[0].x).toBe(0);
    expect(s.ticksX[6].x).toBe(1);
  });

  it('labels a week by day and longer ranges by date', () => {
    expect(overviewSeries([], '7D', NOW).ticksX).toHaveLength(7);
    expect(overviewSeries([], '30D', NOW).ticksX).toHaveLength(6);
    expect(overviewSeries([], '30D', NOW).ticksX[0].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('axis helpers', () => {
  it('niceCeil rounds up to 1, 2, 5 times a power of ten', () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(345)).toBe(500);
    expect(niceCeil(500)).toBe(500);
    expect(niceCeil(501)).toBe(1000);
    expect(niceCeil(7200)).toBe(10000);
  });

  it('fmtAxis reads like a chart axis', () => {
    expect(fmtAxis(0)).toBe('0');
    expect(fmtAxis(500)).toBe('500');
    expect(fmtAxis(1000)).toBe('1.0K');
    expect(fmtAxis(-1250)).toBe('-1.3K');
  });
});
