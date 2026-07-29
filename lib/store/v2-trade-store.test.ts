import { describe, it, expect } from 'vitest';
import { defaultStakeForBalance, STARTER_DEFAULT_STAKE } from './v2-trade-store';
import { toQuote } from '@/config/scale';

describe('defaultStakeForBalance', () => {
  it('defaults to $10 when the wallet covers it', () => {
    expect(defaultStakeForBalance(toQuote(10))).toBe(10);
    expect(defaultStakeForBalance(toQuote(25))).toBe(10); // capped at the $10 default
    expect(defaultStakeForBalance(toQuote(1000))).toBe(10);
    expect(STARTER_DEFAULT_STAKE).toBe(10);
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
});
