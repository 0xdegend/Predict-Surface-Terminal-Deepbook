import { describe, it, expect } from 'vitest';
import {
  encodeRecipe,
  decodeRecipe,
  normalizeRecipe,
  buildRecipe,
  recipeLabel,
  RECIPE_VERSION,
  type TradeRecipe,
} from './trade-link';

const binary: TradeRecipe = { v: 1, tenor: '1m', mode: 'binary', isUp: true, strike: 91480, stake: 50, lev: 2 };
const range: TradeRecipe = { v: 1, tenor: '5m', mode: 'range', lower: 88000, higher: 94000, stake: 25, lev: 1 };

describe('encode / decode round-trip', () => {
  it('round-trips a binary recipe', () => {
    expect(decodeRecipe(encodeRecipe(binary))).toEqual(binary);
  });

  it('round-trips a range recipe', () => {
    expect(decodeRecipe(encodeRecipe(range))).toEqual(range);
  });

  it('round-trips a binary recipe with an attribution ref', () => {
    const r: TradeRecipe = { ...binary, ref: 'alex' };
    expect(decodeRecipe(encodeRecipe(r))).toEqual(r);
  });

  it('preserves an omitted strike (follow ATM) as undefined', () => {
    const r: TradeRecipe = { v: 1, tenor: '1h', mode: 'binary', isUp: false, stake: 10, lev: 1 };
    const back = decodeRecipe(encodeRecipe(r));
    expect(back).toEqual(r);
    expect(back?.strike).toBeUndefined();
  });

  it('produces URL-safe tokens (no + / = characters)', () => {
    const token = encodeRecipe({ ...binary, ref: 'a name with symbols' });
    expect(token).not.toMatch(/[+/=]/);
  });
});

describe('decode rejects bad input', () => {
  it('returns null for garbage', () => {
    expect(decodeRecipe('not-a-real-token!!!')).toBeNull();
    expect(decodeRecipe('')).toBeNull();
    expect(decodeRecipe(null)).toBeNull();
    expect(decodeRecipe(undefined)).toBeNull();
  });

  it('returns null for the wrong version', () => {
    expect(normalizeRecipe({ ...binary, v: 2 })).toBeNull();
  });

  it('returns null for an unknown tenor', () => {
    expect(normalizeRecipe({ ...binary, tenor: '2w' })).toBeNull();
  });

  it('returns null for an unknown mode', () => {
    expect(normalizeRecipe({ ...binary, mode: 'ladder' })).toBeNull();
  });

  it('returns null for an oversized token', () => {
    expect(decodeRecipe('A'.repeat(600))).toBeNull();
  });
});

describe('binary validation', () => {
  it('requires a boolean direction', () => {
    expect(normalizeRecipe({ v: 1, tenor: '1m', mode: 'binary', strike: 100, stake: 5, lev: 1 })).toBeNull();
  });

  it('drops a non-positive or non-finite strike (falls back to ATM)', () => {
    expect(normalizeRecipe({ ...binary, strike: -5 })?.strike).toBeUndefined();
    expect(normalizeRecipe({ ...binary, strike: Infinity })?.strike).toBeUndefined();
    expect(normalizeRecipe({ ...binary, strike: 0 })?.strike).toBeUndefined();
  });
});

describe('range validation', () => {
  it('sorts the band edges', () => {
    const out = normalizeRecipe({ v: 1, tenor: '1m', mode: 'range', lower: 94000, higher: 88000, stake: 5, lev: 1 });
    expect(out).toMatchObject({ lower: 88000, higher: 94000 });
  });

  it('rejects a degenerate band (equal edges) or a missing edge', () => {
    expect(normalizeRecipe({ v: 1, tenor: '1m', mode: 'range', lower: 90000, higher: 90000, stake: 5, lev: 1 })).toBeNull();
    expect(normalizeRecipe({ v: 1, tenor: '1m', mode: 'range', lower: 90000, stake: 5, lev: 1 })).toBeNull();
  });
});

describe('stake / leverage clamping', () => {
  it('rejects a non-positive or non-finite stake', () => {
    expect(normalizeRecipe({ ...binary, stake: 0 })).toBeNull();
    expect(normalizeRecipe({ ...binary, stake: -10 })).toBeNull();
    expect(normalizeRecipe({ ...binary, stake: NaN })).toBeNull();
  });

  it('clamps an absurd stake to the ceiling', () => {
    expect(normalizeRecipe({ ...binary, stake: 9e12 })?.stake).toBe(1_000_000);
  });

  it('defaults missing / invalid leverage to 1 and clamps the range', () => {
    expect(normalizeRecipe({ ...binary, lev: undefined })?.lev).toBe(1);
    expect(normalizeRecipe({ ...binary, lev: 0.2 })?.lev).toBe(1);
    expect(normalizeRecipe({ ...binary, lev: 999 })?.lev).toBe(100);
  });
});

describe('ref sanitization', () => {
  it('preserves internal spaces (real display names) and trims the outer ones', () => {
    // Built with explicit spaces so the assertion is unambiguous.
    const ref = '  al' + ' ' + 'ex  ';
    expect(normalizeRecipe({ ...binary, ref })?.ref).toBe('al ex');
  });

  it('strips control characters', () => {
    const ref = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(31) + 'c' + String.fromCharCode(127) + 'd';
    expect(normalizeRecipe({ ...binary, ref })?.ref).toBe('abcd');
  });

  it('drops an all-whitespace ref entirely', () => {
    expect(normalizeRecipe({ ...binary, ref: '   ' })?.ref).toBeUndefined();
  });

  it('truncates a very long ref to 40 chars', () => {
    expect(normalizeRecipe({ ...binary, ref: 'x'.repeat(100) })?.ref?.length).toBe(40);
  });
});

describe('buildRecipe', () => {
  it('accepts null strike / band as omitted', () => {
    const r = buildRecipe({ tenor: '1m', mode: 'binary', isUp: true, strike: null, stake: 20, lev: 1 });
    expect(r).toEqual({ v: RECIPE_VERSION, tenor: '1m', mode: 'binary', isUp: true, stake: 20, lev: 1 });
  });

  it('returns null when the shape is invalid', () => {
    expect(buildRecipe({ tenor: '1m', mode: 'range', lower: null, higher: null, stake: 20, lev: 1 })).toBeNull();
  });
});

describe('recipeLabel', () => {
  it('labels a binary above/below with a strike', () => {
    expect(recipeLabel(binary)).toBe('BTC above $91,480 · $50 · 2x');
    expect(recipeLabel({ ...binary, isUp: false, lev: 1 })).toBe('BTC below $91,480 · $50');
  });

  it('labels a strikeless binary as up/down from here', () => {
    expect(recipeLabel({ v: 1, tenor: '1m', mode: 'binary', isUp: true, stake: 10, lev: 1 })).toBe('BTC up from here · $10');
  });

  it('labels a range', () => {
    expect(recipeLabel(range)).toBe('BTC between $88,000 and $94,000 · $25');
  });
});
