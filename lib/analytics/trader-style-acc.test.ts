import { describe, it, expect } from 'vitest';
import {
  emptyStyleAcc,
  foldMint,
  statsFromAcc,
  classifyAcc,
  computeStyleStats,
  type StyleMint,
} from './trader-style';
import { FLOAT_SCALING } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';

const Q = 1_000_000; // @6dec → 1 DUSDC
const E9 = FLOAT_SCALING;

const foldAll = (mints: StyleMint[]) => {
  const acc = emptyStyleAcc();
  for (const m of mints) foldMint(acc, m);
  return acc;
};

// A binary StyleMint and the equivalent PositionSummary, so the streaming path and the
// list path can be compared field-for-field.
const bin = (cost: number, entry: number, up: boolean, market: string): StyleMint => ({
  cost,
  entry,
  side: up ? 'up' : 'down',
  market,
});
const pos = (cost: number, entry: number, up: boolean, market: string): PositionSummary =>
  ({ oracle_id: market, is_up: up, total_cost: cost * Q, average_entry_price: entry * E9 } as unknown as PositionSummary);

describe('foldMint / statsFromAcc parity with computeStyleStats (binary-only)', () => {
  it('produces the same stats as the list path', () => {
    const mints = [bin(3, 0.2, true, '0xA'), bin(1, 0.8, false, '0xB')];
    const poss = [pos(3, 0.2, true, '0xA'), pos(1, 0.8, false, '0xB')];
    const a = statsFromAcc(foldAll(mints));
    const b = computeStyleStats(poss);
    expect(a.positions).toBe(b.positions);
    expect(a.sample).toBe(b.sample); // both = binary count when no range bets
    expect(a.volume).toBeCloseTo(b.volume);
    expect(a.avgBet).toBeCloseTo(b.avgBet);
    expect(a.avgEntry).toBeCloseTo(b.avgEntry);
    expect(a.tailShare).toBeCloseTo(b.tailShare);
    expect(a.favShare).toBeCloseTo(b.favShare);
    expect(a.upShare).toBeCloseTo(b.upShare);
    expect(a.markets).toBe(b.markets);
    expect(a.rangeShare).toBeCloseTo(b.rangeShare);
  });

  it('ignores zero-cost mints (same guard as the list path)', () => {
    const acc = foldAll([bin(0, 0.5, true, '0xA'), bin(2, 0.5, true, '0xA')]);
    expect(statsFromAcc(acc).positions).toBe(1);
  });
});

describe('foldMint additivity', () => {
  it('is order- and chunk-independent', () => {
    const mints = [bin(2, 0.3, true, '0xA'), bin(1, 0.9, false, '0xB'), bin(5, 0.5, true, '0xC')];
    const whole = statsFromAcc(foldAll(mints));

    // Fold the same mints split across two "delta" batches, reversed — additive sums
    // must land in exactly the same place.
    const acc = emptyStyleAcc();
    for (const m of [...mints].reverse().slice(0, 2)) foldMint(acc, m);
    for (const m of [...mints].reverse().slice(2)) foldMint(acc, m);
    const split = statsFromAcc(acc);

    expect(split).toEqual(whole);
  });
});

describe('range bettors are included (the completeness fix)', () => {
  const range = (cost: number, market: string): StyleMint => ({ cost, entry: 0, side: 'range', market });

  it('classifies a pure-range wallet as range, where the binary-only list path drops it', () => {
    // Streaming path: 3 range bets clear the sample floor and read as a range bettor.
    const acc = foldAll([range(2, '0xA'), range(2, '0xB'), range(2, '0xC')]);
    expect(statsFromAcc(acc).sample).toBe(3);
    expect(classifyAcc(acc).primary?.id).toBe('range');

    // List path with zero binary positions can't reach the floor → no style.
    expect(computeStyleStats([]).sample).toBe(0);
  });

  it('counts range bets toward the sample alongside binaries', () => {
    const acc = foldAll([bin(1, 0.5, true, '0xA'), bin(1, 0.5, true, '0xA'), range(1, '0xB')]);
    const s = statsFromAcc(acc);
    expect(s.positions).toBe(2); // binary count (avgBet base)
    expect(s.sample).toBe(3); // binary + range → clears MIN_SAMPLE
    expect(classifyAcc(acc).primary).not.toBeNull();
  });
});
