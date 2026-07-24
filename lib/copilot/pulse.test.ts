import { describe, it, expect } from 'vitest';
import {
  marketUpChance,
  marketAtmIv,
  marketRows,
  nextExpiry,
  volState,
  arbState,
  suggestChips,
} from './pulse';
import type { BetCandidate } from './respond';
import type { SviFloat } from '@/lib/svi/svi';
import type { SmileInput } from '@/lib/svi/surface';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { Oracle } from '@/lib/api/types';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const NOW = 1_700_000_000_000;

function candidate(id: string, minutesOut: number, forward = 65_000): BetCandidate {
  const market = { expiry_market_id: id, expiry: NOW + minutesOut * 60_000 } as unknown as V2Market;
  const pricer: LivePricer = { expiryMarketId: id, forward, svi: SVI };
  return { market, pricer };
}

function smile(id: string, minutesOut: number, forward = 65_000): SmileInput {
  return {
    oracle: { oracle_id: id, expiry: NOW + minutesOut * 60_000, underlying_asset: 'BTC' } as unknown as Oracle,
    svi: SVI,
    forward,
  };
}

/** 40 near-flat closes → tiny realized move (surface prices far more → elevated). */
const FLAT_CLOSES = Array.from({ length: 40 }, (_, i) => 65_000 * (1 + 0.0001 * (i % 2 ? 1 : -1)));
/** 40 choppy closes alternating ±5% → large realized move (surface calmer). */
const CHOPPY_CLOSES = Array.from({ length: 40 }, (_, i) => 65_000 * (i % 2 ? 1.05 : 1));

describe('pulse — market metrics', () => {
  it('upChance sits just under 50% at the money (median < forward)', () => {
    const p = marketUpChance(candidate('m', 4).pricer, 65_000);
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.5);
  });

  it('a higher current price lowers the chance of finishing above it', () => {
    const pAt = marketUpChance(candidate('m', 4).pricer, 65_000);
    const pHigh = marketUpChance(candidate('m', 4).pricer, 66_000);
    expect(pHigh).toBeLessThan(pAt);
  });

  it('ATM implied vol is positive', () => {
    expect(marketAtmIv(candidate('m', 4).pricer, NOW + 4 * 60_000, NOW)).toBeGreaterThan(0);
  });

  it('marketRows returns only open markets, soonest first', () => {
    const rows = marketRows([candidate('late', 58), candidate('soon', 4), candidate('past', -3)], 65_000, NOW);
    expect(rows.map((r) => r.marketId)).toEqual(['soon', 'late']);
    expect(rows[0].iv).toBeGreaterThan(0);
  });

  it('drops rows inside the runway buffer, keeping the rail in step with the surface', () => {
    // 'soon' is ~3s out; with an 8s floor it must not be offered (the surface has
    // already pruned it), while the 4-min market stays.
    const rows = marketRows([candidate('soon', 0.05), candidate('ok', 4)], 65_000, NOW, 8_000);
    expect(rows.map((r) => r.marketId)).toEqual(['ok']);
  });

  it('nextExpiry is the soonest open expiry', () => {
    expect(nextExpiry([candidate('late', 58), candidate('soon', 4)], NOW)).toBe(NOW + 4 * 60_000);
    expect(nextExpiry([], NOW)).toBeNull();
  });
});

describe('pulse — vol state (mirrors the chat verdict)', () => {
  it('elevated when the surface prices a bigger move than BTC has been making', () => {
    expect(volState([candidate('soon', 4)], FLAT_CLOSES, NOW)).toBe('elevated');
  });

  it('calm when the surface prices a smaller move than realized', () => {
    expect(volState([candidate('soon', 4)], CHOPPY_CLOSES, NOW)).toBe('calm');
  });

  it('null (unknown) with no candle history to judge against', () => {
    expect(volState([candidate('soon', 4)], null, NOW)).toBeNull();
    expect(volState([], FLAT_CLOSES, NOW)).toBeNull();
  });
});

describe('pulse — arb state', () => {
  it('clean on a normal live surface', () => {
    expect(arbState([smile('a', 4), smile('b', 58)], NOW)).toBe('clean');
  });

  it('null when there are fewer than two expiries to check', () => {
    expect(arbState([smile('a', 4)], NOW)).toBeNull();
    expect(arbState(null, NOW)).toBeNull();
  });
});

describe('pulse — adaptive chips', () => {
  it('surfaces the volatility question when vol is elevated', () => {
    const chips = suggestChips({ vol: 'elevated', arb: 'clean', bias: null, hasPortfolio: false });
    expect(chips).toContain('Why is BTC so volatile?');
  });

  it('surfaces the arb question only when the surface needs watching', () => {
    expect(suggestChips({ vol: null, arb: 'watch', bias: null, hasPortfolio: false })).toContain('Any mispricings right now?');
    expect(suggestChips({ vol: null, arb: 'clean', bias: null, hasPortfolio: false })).not.toContain('Any mispricings right now?');
  });

  it('flips the bet side with the off-chain bias', () => {
    expect(suggestChips({ vol: null, arb: null, bias: { pick: 'down', confidence: 'slight' }, hasPortfolio: false })).toContain('Safe DOWN bet');
    expect(suggestChips({ vol: null, arb: null, bias: { pick: 'up', confidence: 'clear' }, hasPortfolio: false })).toContain('Safe UP bet');
  });

  it('adds the portfolio question when there is an open book, and caps at six', () => {
    const chips = suggestChips({ vol: 'elevated', arb: 'watch', bias: { pick: 'up', confidence: 'slight' }, hasPortfolio: true });
    expect(chips).toContain("How's my portfolio?");
    expect(chips.length).toBeLessThanOrEqual(6);
    expect(new Set(chips).size).toBe(chips.length); // no duplicates
  });
});
