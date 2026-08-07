import { describe, it, expect } from 'vitest';
import { mergeLegacyCarryover } from './legacy-carryover';
import type { V2LeaderboardRow } from './v2';

const legacy = new Map([
  ['0xaaa', { owner: '0xAAA', points: 100, volume: 50, trades: 5, netPnl: 20 }],
  ['0xbbb', { owner: '0xBBB', points: 40, volume: 10, trades: 2, netPnl: 5 }],
]);

const row = (owner: string, points: number, volume = 0, trades = 0): V2LeaderboardRow => ({
  owner,
  points,
  volume,
  trades,
});

describe('mergeLegacyCarryover', () => {
  it('adds legacy points to a returning trader (case-insensitive) and records legacyPoints', () => {
    const merged = mergeLegacyCarryover([row('0xAAA', 30, 15, 3)], legacy);
    const a = merged.find((r) => r.owner.toLowerCase() === '0xaaa')!;
    expect(a.points).toBe(130); // 30 live + 100 legacy
    expect(a.volume).toBe(65);
    expect(a.trades).toBe(8);
    expect(a.netPnl).toBe(20);
    expect(a.legacyPoints).toBe(100);
    expect(a.viaSkew).toBe(true);
  });

  it('adds a legacy-only trader who has not traded on the new deployment yet', () => {
    const merged = mergeLegacyCarryover([row('0xAAA', 30)], legacy);
    const b = merged.find((r) => r.owner.toLowerCase() === '0xbbb')!;
    expect(b.points).toBe(40);
    expect(b.legacyPoints).toBe(40);
    expect(b.volume).toBe(10);
    expect(b.trades).toBe(2);
  });

  it('keeps a live-only trader (no legacy) untouched and ranks by points desc', () => {
    const merged = mergeLegacyCarryover([row('0xAAA', 5), row('0xCCC', 999)], legacy);
    // 0xCCC=999 (no legacy), 0xAAA=5+100=105, 0xBBB=40
    expect(merged.map((r) => r.owner.toLowerCase())).toEqual(['0xccc', '0xaaa', '0xbbb']);
    expect(merged.find((r) => r.owner === '0xCCC')!.legacyPoints).toBeUndefined();
  });

  it('does not mutate the input rows', () => {
    const rows = [row('0xAAA', 30, 15, 3)];
    mergeLegacyCarryover(rows, legacy);
    expect(rows[0]).toEqual({ owner: '0xAAA', points: 30, volume: 15, trades: 3 });
  });

  it('no-ops when there is no legacy data', () => {
    const rows = [row('0xAAA', 30)];
    expect(mergeLegacyCarryover(rows, new Map())).toBe(rows);
  });
});
