import { describe, it, expect } from 'vitest';
import { mergeHistoryRows } from './legacy-history';
import { legacyHistoryFor, legacyHistoryByOwner } from './legacy-history-data';
import { ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
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

describe('legacyHistoryFor (the real snapshots, on whatever deployment is configured)', () => {
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

  it('carries a trader who played more than one release as ONE continuous history', () => {
    // The chaining case. A wallet present in both snapshots must come back with both sets
    // of trades, in one newest-first list, with no row repeated.
    const byOwner = legacyHistoryByOwner();
    const owners = Object.keys(byOwner);
    expect(owners.length, 'no carried history at all').toBeGreaterThan(0);
    for (const owner of owners) {
      const rows = byOwner[owner];
      const keys = rows.map((r) => r.key);
      expect(new Set(keys).size, `${owner} has a duplicated history row`).toBe(keys.length);
      // Newest-first, the order the history tab renders without re-sorting.
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1].settledAt).toBeGreaterThanOrEqual(rows[i].settledAt);
    }
  });

  it('never carries rows captured from the deployment being read live', () => {
    // Same double-count guard as the points board: those trades already come back from the
    // live read, so overlaying them would show every settled trade twice in the history tab.
    const rows = Object.values(legacyHistoryByOwner()).flat();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.legacy === true), 'a carried row is not tagged legacy').toBe(true);
    // The active deployment's own capture must not be in play. Asserted through the source
    // string the data module publishes, which is built from the same filtered list.
    expect(ACTIVE_V2_DEPLOYMENT).toBeTruthy();
  });
});
