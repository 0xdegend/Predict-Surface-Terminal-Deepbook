import { describe, it, expect } from 'vitest';
import { roundLineScaled, quoteSide } from '@/lib/sui/v2/simple-round';
import { POS_INF_TICK, NEG_INF_TICK, strikeToTick } from '@/lib/sui/v2/ticks';
import { toFloat, toQuote } from '@/config/scale';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { SviFloat } from '@/lib/svi/svi';

// BTC market grid from the live 8-06 deployment: tick $0.01 (1e9-scaled), admission $1.
const TICK = '10000000';
const ADMISSION = '1000000000';
const MARKET = { tick_size: TICK, base_fee: '20000000' }; // base_fee = 2%

// A near-symmetric SVI so at-the-money sits ~50/50 (matches the live probe).
const SVI: SviFloat = { a: 0.02, b: 0.1, rho: 0, m: 0, sigma: 0.3 };
const pricerAt = (forward: number): LivePricer => ({ expiryMarketId: '0x1', forward, svi: SVI });

describe('roundLineScaled', () => {
  it('pins the line to reference_tick (a tick index → price via tickToStrike)', () => {
    const { lineScaled, pinned } = roundLineScaled(6938029, 69391.43, TICK, ADMISSION);
    expect(pinned).toBe(true);
    expect(toFloat(lineScaled)).toBeCloseTo(69380.29, 2);
  });

  it('falls back to the snapped at-the-money forward when reference_tick is null', () => {
    const { lineScaled, pinned } = roundLineScaled(null, 69391.43, TICK, ADMISSION);
    expect(pinned).toBe(false);
    // snapped to the $1 admission grid
    expect(toFloat(lineScaled)).toBe(69391);
  });

  it('treats an empty-string reference_tick as unset', () => {
    expect(roundLineScaled('', 69391.43, TICK, ADMISSION).pinned).toBe(false);
  });
});

describe('quoteSide', () => {
  const { lineScaled } = roundLineScaled(null, 69391.43, TICK, ADMISSION); // ATM line = $69391
  const strikeTick = strikeToTick(lineScaled, TICK);

  it('quotes UP and DOWN as complementary probabilities near ATM', () => {
    const up = quoteSide(MARKET, pricerAt(69391.43), lineScaled, 10, true);
    const dn = quoteSide(MARKET, pricerAt(69391.43), lineScaled, 10, false);
    expect(up.entryProb).toBeGreaterThan(0.3);
    expect(up.entryProb).toBeLessThan(0.7);
    expect(up.entryProb + dn.entryProb).toBeCloseTo(1, 6);
    expect(up.quotable).toBe(true);
    expect(dn.quotable).toBe(true);
  });

  it('sets the multiplier to ~1/entryProb (win = quantity at 1x)', () => {
    const up = quoteSide(MARKET, pricerAt(69391.43), lineScaled, 10, true);
    expect(up.stakeBase).toBe(toQuote(10));
    expect(up.winBase).toBeGreaterThan(up.stakeBase); // near-even bet pays > stake
    expect(up.multiplier).toBeCloseTo(1 / up.entryProb, 1);
  });

  it('maps UP to (strikeTick, +inf) and DOWN to (-inf, strikeTick)', () => {
    const up = quoteSide(MARKET, pricerAt(69391.43), lineScaled, 10, true);
    const dn = quoteSide(MARKET, pricerAt(69391.43), lineScaled, 10, false);
    expect(up.ticks.lowerTick).toBe(strikeTick);
    expect(up.ticks.higherTick).toBe(POS_INF_TICK);
    expect(dn.ticks.lowerTick).toBe(NEG_INF_TICK);
    expect(dn.ticks.higherTick).toBe(strikeTick);
  });

  it('marks a wildly one-sided side as not quotable', () => {
    // Line far BELOW the forward → UP is near-certain, DOWN near-impossible: neither
    // is inside the priceable band.
    const { lineScaled: lowLine } = roundLineScaled(1000000, 69391.43, TICK, ADMISSION); // line ≈ $10,000
    const up = quoteSide(MARKET, pricerAt(69391.43), lowLine, 10, true);
    const dn = quoteSide(MARKET, pricerAt(69391.43), lowLine, 10, false);
    expect(up.entryProb).toBeGreaterThan(0.99);
    expect(up.quotable).toBe(false);
    expect(dn.quotable).toBe(false);
  });

  it('is not quotable below the $1 minimum stake', () => {
    const tiny = quoteSide(MARKET, pricerAt(69391.43), lineScaled, 0.5, true);
    expect(tiny.quotable).toBe(false);
  });
});
