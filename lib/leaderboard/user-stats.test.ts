import { describe, it, expect } from 'vitest';
import { computeSkewUserStats } from './user-stats';
import type { V2LeaderboardRow } from './v2';
import type { PastPrediction } from '@/lib/portfolio/history';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const trader = (owner: string, over: Partial<V2LeaderboardRow> = {}): V2LeaderboardRow => ({
  owner,
  points: 100,
  volume: 500,
  trades: 4,
  netPnl: 25,
  ...over,
});

const pos = (result: 'won' | 'lost', settledAt: number, pnl: number): PastPrediction =>
  ({ key: `${result}-${settledAt}`, result, settledAt, pnl } as unknown as PastPrediction);

describe('computeSkewUserStats', () => {
  it('counts users, traders, faucet onboards and active traders', () => {
    const rows: V2LeaderboardRow[] = [
      trader('0xaa', { lastActiveMs: NOW - DAY }), // active
      trader('0xbb', { lastActiveMs: NOW - 30 * DAY }), // stale
      { owner: '0xcc', points: 1, volume: 0, trades: 0, viaFaucet: true }, // faucet onboard
      trader('0xdd', { viaFaucet: true }), // claimed AND traded → converted
    ];
    const s = computeSkewUserStats(rows, {}, NOW);
    expect(s.totalUsers).toBe(4);
    expect(s.tradingUsers).toBe(3);
    expect(s.faucetOnboards).toBe(1);
    expect(s.activeUsers7d).toBe(1);
    expect(s.faucetTotal).toBe(2);
    expect(s.faucetConverted).toBe(1);
  });

  it('sums volume/trades/points and profitability', () => {
    const rows = [
      trader('0xaa', { netPnl: 50, volume: 100, trades: 2, points: 10 }),
      trader('0xbb', { netPnl: -20, volume: 300, trades: 5, points: 30 }),
    ];
    const s = computeSkewUserStats(rows, {}, NOW);
    expect(s.totalVolume).toBe(400);
    expect(s.totalTrades).toBe(7);
    expect(s.totalPoints).toBe(40);
    expect(s.netPositiveTraders).toBe(1);
    expect(s.avgNetPnl).toBeCloseTo(15); // (50 + -20) / 2
  });

  it('derives win/loss rate and realized PnL from resolved history', () => {
    const history = {
      '0xaa': [pos('won', NOW - 5 * DAY, 40), pos('lost', NOW - 4 * DAY, -10)],
      '0xbb': [pos('won', NOW - 3 * DAY, 15)],
    };
    const s = computeSkewUserStats([], history, NOW);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.resolvedPositions).toBe(3);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.lossRate).toBeCloseTo(1 / 3);
    expect(s.realizedPnl).toBe(45);
  });

  it('builds a cumulative join curve from each owner’s first resolved bet', () => {
    const history = {
      '0xaa': [pos('won', NOW - 10 * DAY, 1), pos('lost', NOW - 2 * DAY, -1)], // first = -10d
      '0xbb': [pos('won', NOW - 5 * DAY, 1)], // first = -5d
    };
    const s = computeSkewUserStats([], history, NOW);
    expect(s.joinSeries.map((p) => p.y)).toEqual([1, 2]); // cumulative
    expect(s.joinSeries[0].x).toBeLessThan(s.joinSeries[1].x); // sorted ascending
  });

  it('ranks top traders by net PnL and caps to topN', () => {
    const rows = [
      trader('0xaa', { netPnl: 10 }),
      trader('0xbb', { netPnl: 90 }),
      trader('0xcc', { netPnl: 50 }),
    ];
    const s = computeSkewUserStats(rows, {}, NOW, 2);
    expect(s.topTraders.map((t) => t.owner)).toEqual(['0xbb', '0xcc']);
  });

  it('degrades to zeros on empty inputs (never divides by zero)', () => {
    const s = computeSkewUserStats([], {}, NOW);
    expect(s.totalUsers).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.avgNetPnl).toBe(0);
    expect(s.topTraders).toEqual([]);
    expect(s.joinSeries).toEqual([]);
  });
});
