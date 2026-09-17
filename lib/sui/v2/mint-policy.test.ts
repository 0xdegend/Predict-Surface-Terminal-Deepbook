/**
 * The band is the chain's, not a literal.
 *
 * These pin the two dead zones that existed while the app hardcoded 0.005/0.995 against a
 * chain enforcing 1% to 99%: a bet in either gap was quoted, funded, and then refused by
 * the wallet's dry run (`assert_mint_probability_policy`), which reads to a trader as the
 * app being broken.
 */
import { describe, it, expect } from 'vitest';
import { mintProbabilityBand, probabilityMintable, FALLBACK_BAND } from './mint-policy';

const market = (min: string, max: string) =>
  ({ min_entry_probability: min, max_entry_probability: max }) as const;

describe('mintProbabilityBand', () => {
  it('reads the market’s own bounds', () => {
    expect(mintProbabilityBand(market('10000000', '990000000'))).toEqual({ min: 0.01, max: 0.99 });
  });

  it('falls back when a market is missing or incomplete, never widening', () => {
    expect(mintProbabilityBand(undefined)).toEqual(FALLBACK_BAND);
    expect(mintProbabilityBand({} as never)).toEqual(FALLBACK_BAND);
    // A zero bound is not "0% allowed", it is an unread field.
    expect(mintProbabilityBand(market('0', '0'))).toEqual(FALLBACK_BAND);
  });

  it('matches what 9-12 enforces on chain (verified 2026-09-17)', () => {
    expect(FALLBACK_BAND).toEqual({ min: 0.01, max: 0.99 });
  });
});

describe('probabilityMintable', () => {
  const m = market('10000000', '990000000');

  it('admits ordinary odds', () => {
    for (const p of [0.02, 0.5, 0.97]) expect(probabilityMintable(p, m), String(p)).toBe(true);
  });

  it('REFUSES the two gaps the old hardcoded band let through', () => {
    // Both of these passed `> 0.005 && < 0.995` and abort on chain.
    for (const p of [0.006, 0.0099, 0.9901, 0.994]) {
      expect(probabilityMintable(p, m), `${p} must not reach the wallet`).toBe(false);
    }
  });

  it('is exclusive at both bounds, matching the chain’s strict comparison', () => {
    expect(probabilityMintable(0.01, m)).toBe(false);
    expect(probabilityMintable(0.99, m)).toBe(false);
  });

  it('honours a market that is stricter than the fallback', () => {
    const tight = market('100000000', '900000000'); // 10% .. 90%
    expect(probabilityMintable(0.05, tight)).toBe(false);
    expect(probabilityMintable(0.5, tight)).toBe(true);
    expect(probabilityMintable(0.95, tight)).toBe(false);
  });
});
