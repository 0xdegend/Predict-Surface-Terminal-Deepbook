import { describe, it, expect } from 'vitest';
import { defaultStakeForBalance, STARTER_DEFAULT_STAKE, betPresets } from './v2-trade-store';
import { toQuote } from '@/config/scale';

describe('defaultStakeForBalance', () => {
  it('defaults to $10 for a modestly funded wallet', () => {
    expect(defaultStakeForBalance(toQuote(10))).toBe(10);
    expect(defaultStakeForBalance(toQuote(25))).toBe(10);
    expect(defaultStakeForBalance(toQuote(500))).toBe(10);
    expect(defaultStakeForBalance(toQuote(999))).toBe(10);
    expect(STARTER_DEFAULT_STAKE).toBe(10);
  });

  it('scales the default UP for higher-liquidity wallets (the reported bug)', () => {
    expect(defaultStakeForBalance(toQuote(1_000))).toBe(25);
    expect(defaultStakeForBalance(toQuote(3_000))).toBe(50);
    expect(defaultStakeForBalance(toQuote(10_000))).toBe(100);
    expect(defaultStakeForBalance(toQuote(18_071))).toBe(100); // no longer stuck at $10
    expect(defaultStakeForBalance(toQuote(50_000))).toBe(250);
    expect(defaultStakeForBalance(toQuote(250_000))).toBe(500);
  });

  it('steps down to the biggest preset a small wallet can cover', () => {
    expect(defaultStakeForBalance(toQuote(9.99))).toBe(5);
    expect(defaultStakeForBalance(toQuote(5))).toBe(5);
    expect(defaultStakeForBalance(toQuote(4.99))).toBe(1);
    expect(defaultStakeForBalance(toQuote(2))).toBe(1); // the reported ~1-2 DUSDC case
    expect(defaultStakeForBalance(toQuote(1))).toBe(1);
  });

  it('floors at $1 even for a near-empty wallet', () => {
    expect(defaultStakeForBalance(toQuote(0.5))).toBe(1);
    expect(defaultStakeForBalance(0n)).toBe(1);
  });

  it('the seeded default always matches one of the visible presets', () => {
    for (const bal of [50, 150, 400, 1_000, 3_000, 18_071, 60_000, 250_000]) {
      expect(betPresets(toQuote(bal)), `bal ${bal}`).toContain(defaultStakeForBalance(toQuote(bal)));
    }
  });
});

describe('betPresets', () => {
  it('gives small wallets the $1–$25 ladder', () => {
    expect(betPresets(toQuote(0))).toEqual([1, 5, 10, 25]);
    expect(betPresets(toQuote(50))).toEqual([1, 5, 10, 25]);
    expect(betPresets(toQuote(99.99))).toEqual([1, 5, 10, 25]);
  });

  it('scales the ladder up with the balance', () => {
    expect(betPresets(toQuote(100))).toEqual([5, 10, 25, 50]);
    expect(betPresets(toQuote(300))).toEqual([10, 25, 50, 100]);
    expect(betPresets(toQuote(1_000))).toEqual([25, 50, 100, 250]);
    expect(betPresets(toQuote(3_000))).toEqual([50, 100, 250, 500]);
  });

  it('lands on [100,300,500,1000] for a well-funded (18k) account', () => {
    expect(betPresets(toQuote(18_071))).toEqual([100, 300, 500, 1_000]);
  });

  it('tops out at the largest tier', () => {
    expect(betPresets(toQuote(50_000))).toEqual([250, 500, 1_000, 2_500]);
    expect(betPresets(toQuote(250_000))).toEqual([500, 1_000, 2_500, 5_000]);
  });

  it('always returns four ascending values', () => {
    for (const bal of [0, 100, 1_000, 18_071, 999_999]) {
      const p = betPresets(toQuote(bal));
      expect(p).toHaveLength(4);
      for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
    }
  });
});
