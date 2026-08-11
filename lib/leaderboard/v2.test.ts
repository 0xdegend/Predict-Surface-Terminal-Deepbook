import { describe, it, expect } from 'vitest';
import { standingFor, type V2LeaderboardRow } from './v2';

const row = (owner: string, points: number, volume: number, o: Partial<V2LeaderboardRow> = {}): V2LeaderboardRow => ({
  owner,
  points,
  volume,
  trades: 1,
  ...o,
});

describe('standingFor', () => {
  const board: V2LeaderboardRow[] = [
    row('0xAAA', 300, 200, { netPnl: 50, trades: 8 }), // #1
    row('0xBBB', 180, 100, { netPnl: 20, trades: 5 }), // #2
    row('0xCCC', 90, 90, { netPnl: -10, trades: 3 }), // #3
  ];

  it('returns null for a falsy owner', () => {
    expect(standingFor(board, null)).toBeNull();
    expect(standingFor(board, undefined)).toBeNull();
    expect(standingFor(board, '')).toBeNull();
  });

  it('ranks by points and reports the field size', () => {
    const s = standingFor(board, '0xBBB')!;
    expect(s.rank).toBe(2);
    expect(s.total).toBe(3);
    expect(s.points).toBe(180);
    expect(s.volume).toBe(100);
    expect(s.trades).toBe(5);
  });

  it('matches the owner case-insensitively', () => {
    expect(standingFor(board, '0xbbb')!.rank).toBe(2);
    expect(standingFor(board, '0XBBB')!.rank).toBe(2);
  });

  it('back-computes the point split so it sums to points', () => {
    // liquidity = volume·1 = 100; performance = max(0,netPnl)·2 = 40; holding = rest = 40.
    const s = standingFor(board, '0xBBB')!;
    expect(s.liquidityPts).toBe(100);
    expect(s.performancePts).toBe(40);
    expect(s.holdingPts).toBe(40);
    expect(s.liquidityPts + s.performancePts + s.holdingPts).toBeCloseTo(s.points, 6);
  });

  it('floors the performance split at zero for a net loss and never goes negative', () => {
    // netPnl -10 → performance 0; liquidity = 90; holding = 90-90-0 = 0.
    const s = standingFor(board, '0xCCC')!;
    expect(s.performancePts).toBe(0);
    expect(s.holdingPts).toBeGreaterThanOrEqual(0);
  });

  it('reports the gap to the trader one rank up (null at #1)', () => {
    expect(standingFor(board, '0xAAA')!.gapToNext).toBeNull(); // #1
    expect(standingFor(board, '0xBBB')!.gapToNext).toBe(120); // 300 - 180
    expect(standingFor(board, '0xCCC')!.gapToNext).toBe(90); // 180 - 90
  });

  it('returns an unranked standing for a wallet that has never traded', () => {
    const s = standingFor(board, '0xZZZ')!;
    expect(s.rank).toBeNull();
    expect(s.total).toBe(3);
    expect(s.points).toBe(0);
    expect(s.gapToNext).toBeNull();
  });

  it('handles a row with no known netPnl (performance treated as 0)', () => {
    const b = [row('0xDDD', 150, 100)]; // netPnl undefined
    const s = standingFor(b, '0xDDD')!;
    expect(s.liquidityPts).toBe(100);
    expect(s.performancePts).toBe(0);
    expect(s.holdingPts).toBe(50);
  });
});
