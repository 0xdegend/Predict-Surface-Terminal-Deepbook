import { describe, it, expect } from 'vitest';
import { mergeSeedHistory, mergeSeedRows, seedOwners, type SeedRow } from './seed-merge';
import type { PastPrediction } from '@/lib/portfolio/history';

const row = (owner: string, trades: number, points: number, extra: Partial<SeedRow> = {}): SeedRow => ({
  owner,
  points,
  volume: trades * 10,
  trades,
  netPnl: 0,
  skewVolume: trades * 10,
  skewTrades: trades,
  lastActiveMs: 1,
  ...extra,
});

const hist = (key: string, settledAt: number, pnl = 0): PastPrediction =>
  ({ key, settledAt, pnl, strike: 1, up: true } as unknown as PastPrediction);

describe('mergeSeedRows', () => {
  it('keeps an owner only the previous seed knows, unchanged', () => {
    const prev = [row('0xAA', 4, 40)];
    const out = mergeSeedRows([], prev);
    expect(out).toEqual(prev);
  });

  it('takes the fresh row when it has more trades, and the previous row when it has more', () => {
    const fresh = [row('0xaa', 6, 55), row('0xbb', 1, 5)];
    const prev = [row('0xAA', 4, 40), row('0xBB', 3, 30)];
    const out = mergeSeedRows(fresh, prev);
    const byOwner = new Map(out.map((r) => [r.owner.toLowerCase(), r]));
    expect(byOwner.get('0xaa')).toEqual(fresh[0]);
    // Whole row, so the points come from the same read as the count.
    expect(byOwner.get('0xbb')).toEqual(prev[1]);
  });

  it('gives a tie to the fresh row', () => {
    const fresh = [row('0xaa', 4, 44)];
    const prev = [row('0xaa', 4, 40)];
    expect(mergeSeedRows(fresh, prev)).toEqual(fresh);
  });

  it('sorts by points and never drops anyone', () => {
    const fresh = [row('0xcc', 2, 20)];
    const prev = [row('0xaa', 4, 40), row('0xbb', 3, 30)];
    expect(mergeSeedRows(fresh, prev).map((r) => r.owner)).toEqual(['0xaa', '0xbb', '0xcc']);
  });

  it('matches owners case-insensitively without mutating input', () => {
    const fresh = [row('0xAbC', 5, 50)];
    const prev = [row('0xabc', 2, 20)];
    const out = mergeSeedRows(fresh, prev);
    expect(out).toHaveLength(1);
    expect(prev[0].trades).toBe(2);
  });
});

describe('mergeSeedHistory', () => {
  it('unions rows by key, fresh copy winning, newest first, and keeps previous-only wallets', () => {
    const fresh = { '0xaa': [hist('k2', 200, 9), hist('k3', 300)] };
    const prev = { '0xaa': [hist('k1', 100), hist('k2', 200, 1)], '0xbb': [hist('k9', 900)] };
    const out = mergeSeedHistory(fresh, prev);
    expect(out['0xaa'].map((r) => r.key)).toEqual(['k3', 'k2', 'k1']);
    expect(out['0xaa'].find((r) => r.key === 'k2')?.pnl).toBe(9);
    expect(out['0xbb']).toEqual(prev['0xbb']);
  });

  it('drops nothing when there is no previous seed', () => {
    const fresh = { '0xaa': [hist('k1', 1)] };
    expect(mergeSeedHistory(fresh, {})).toEqual(fresh);
  });
});

describe('seedOwners', () => {
  it('lowercases and dedupes', () => {
    expect(seedOwners([{ owner: '0xAA' }, { owner: '0xaa' }, { owner: '0xbb' }])).toEqual(['0xaa', '0xbb']);
  });
});
