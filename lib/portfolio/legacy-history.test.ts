import { describe, it, expect } from 'vitest';
import { mergeHistoryRows, legacyHistoryFor } from './legacy-history';
import type { PastPrediction } from './history';

const row = (key: string, settledAt: number, legacy = false): PastPrediction => ({
  key,
  oracleId: 'm',
  underlying: 'BTC',
  up: true,
  strike: 64000,
  expiry: settledAt,
  settledAt,
  result: 'won',
  contracts: 1,
  cost: 1,
  payout: 2,
  pnl: 1,
  roi: 1,
  entryPrice: 0.5,
  legacy,
});

describe('mergeHistoryRows', () => {
  it('merges legacy under live, newest-first', () => {
    const live = [row('live-2', 200)];
    const legacy = [row('leg-1', 100, true), row('leg-3', 300, true)];
    const merged = mergeHistoryRows(live, legacy);
    expect(merged.map((r) => r.key)).toEqual(['leg-3', 'live-2', 'leg-1']); // settledAt desc
  });

  it('dedupes by key, live wins', () => {
    const live = [row('dup', 100)];
    const legacy = [row('dup', 100, true)];
    const merged = mergeHistoryRows(live, legacy);
    expect(merged).toHaveLength(1);
    expect(merged[0].legacy).toBeFalsy(); // the live row, not the legacy one
  });

  it('returns the live array unchanged when there is no legacy', () => {
    const live = [row('a', 1)];
    expect(mergeHistoryRows(live, [])).toBe(live);
  });
});

describe('legacyHistoryFor (real 6-24 seed, active on the 8-06 default)', () => {
  it('returns nothing for an unknown wallet', () => {
    expect(legacyHistoryFor('0xdead')).toEqual([]);
    expect(legacyHistoryFor(undefined)).toEqual([]);
  });

  it('returns carried-over trades for a known 6-24 wallet (case-insensitive, all tagged legacy)', () => {
    // 0x22cc7ef7… is the top 6-24 Skew trader captured in the seed.
    const owner = '0x22cc7ef79881b98152d9a7c2a50fefe42a468434ddff07e14b08562774a1940f';
    const rows = legacyHistoryFor(owner.toUpperCase());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.legacy === true)).toBe(true);
    expect(rows.every((r) => typeof r.pnl === 'number')).toBe(true);
  });
});
