/**
 * The band is the chain's, not a literal.
 *
 * These pin the two dead zones that existed while the app hardcoded 0.005/0.995 against a
 * chain enforcing 1% to 99%: a bet in either gap was quoted, funded, and then refused by
 * the wallet's dry run (`assert_mint_probability_policy`), which reads to a trader as the
 * app being broken.
 */
import { describe, it, expect } from 'vitest';
import {
  mintProbabilityBand,
  effectiveMintBand,
  costCeilingProbability,
  probabilityMintable,
  FALLBACK_BAND,
} from './mint-policy';

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

describe('cost ceiling — the second bound that raises expiry_market #11', () => {
  // 1e9-scaled, as the chain and the MarketCreated event carry them.
  const market = (over: Record<string, string> = {}) => ({
    min_entry_probability: '10000000', // 1%
    max_entry_probability: '990000000', // 99%
    base_fee: '20000000', // 2% of quantity
    ...over,
  });

  it('caps the EFFECTIVE band below the advertised 99%, because fees cannot fit there', () => {
    // The declared band is untouched — it is a different on-chain rule.
    expect(mintProbabilityBand(market()).max).toBe(0.99);
    const { max } = effectiveMintBand(market());
    // 1 − 2% fee − 0.2% builder (min(10% of fee, 0.5%)) − 0.5% inventory reserve
    expect(max).toBeCloseTo(0.973, 6);
    expect(max).toBeLessThan(0.99);
  });

  it('refuses a 98.5% bet that the old band would have quoted and the chain would reject', () => {
    // premium .985 + fee .02 + builder .002 = 1.007 × quantity > quantity ⇒ abort 11
    expect(probabilityMintable(0.985, market())).toBe(false);
  });

  it('still allows a normal bet well inside the ceiling', () => {
    expect(probabilityMintable(0.9, market())).toBe(true);
    expect(probabilityMintable(0.5, market())).toBe(true);
  });

  it('uses the market’s own inventory rate when 9-12 supplies it', () => {
    const wide = effectiveMintBand(market({ inventory_impact_max_rate: '30000000' })); // 3%
    expect(wide.max).toBeCloseTo(0.948, 6); // 1 − .02 − .002 − .03
    expect(wide.max).toBeLessThan(effectiveMintBand(market()).max);
  });

  it('a lower trading fee raises the ceiling, but never above the declared max', () => {
    const cheap = effectiveMintBand(market({ base_fee: '1000000' })); // 0.1%
    expect(cheap.max).toBe(0.99); // declared max still wins
  });

  it('falls back conservatively when no market is in hand', () => {
    expect(costCeilingProbability(undefined)).toBeCloseTo(0.973, 6);
    expect(effectiveMintBand(undefined).max).toBeLessThan(FALLBACK_BAND.max);
    // ...while the declared fallback itself is unchanged.
    expect(mintProbabilityBand(undefined)).toEqual(FALLBACK_BAND);
  });

  it('leaves the lower bound untouched', () => {
    expect(effectiveMintBand(market()).min).toBeCloseTo(0.01, 6);
    expect(probabilityMintable(0.005, market())).toBe(false);
  });
});
