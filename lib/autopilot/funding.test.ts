import { describe, it, expect } from 'vitest';
import { topUpBase } from './funding';

const $ = (v: number) => BigInt(Math.round(v * 1e6)); // DUSDC has 6 decimals

describe('topUpBase', () => {
  it('moves the whole budget when the account is empty', () => {
    expect(topUpBase($(25), 0n)).toBe($(25));
  });

  it('moves only the difference when the account is part-funded', () => {
    expect(topUpBase($(25), $(15))).toBe($(10));
    expect(topUpBase($(25), $(24.5))).toBe($(0.5));
  });

  it('moves nothing when the account already covers the budget', () => {
    expect(topUpBase($(25), $(25))).toBe(0n);
    // And never goes negative, which would be a deposit in reverse.
    expect(topUpBase($(25), $(400))).toBe(0n);
  });

  it('is exact, with no float rounding on the way through', () => {
    // 0.1 + 0.2 territory: the whole reason this stays in bigint.
    expect(topUpBase($(0.3), $(0.1))).toBe($(0.2));
  });
});
