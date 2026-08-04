import { describe, it, expect } from 'vitest';
import {
  buildStrategy,
  legEconomics,
  grossPayoffAt,
  pnlAt,
  strategyStats,
  legRepricers,
  markAt,
  presetLegs,
  type Leg,
  type Pricer,
} from './strategy';
import { upFair, dnFair, type SviFloat } from '@/lib/svi/svi';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const PRICER: Pricer = { forward: 64_000, svi: SVI };

const up = (strike: number, stake = 100, id = 'u'): Leg => ({ id, kind: 'binary', strike, isUp: true, stake });
const dn = (strike: number, stake = 100, id = 'd'): Leg => ({ id, kind: 'binary', strike, isUp: false, stake });

describe('legEconomics', () => {
  it('sizes payout as stake / fair and rides the fee on the payout', () => {
    const leg = up(65_000, 100);
    const p = upFair(65_000, PRICER.forward, SVI);
    const e = legEconomics(leg, PRICER, 0.002);
    expect(e.prob).toBeCloseTo(p, 10);
    expect(e.payout).toBeCloseTo(100 / p, 6);
    expect(e.fee).toBeCloseTo(0.002 * (100 / p), 6);
    expect(e.cost).toBeCloseTo(100 + 0.002 * (100 / p), 6);
  });
});

describe('single-leg strategy', () => {
  const s = buildStrategy([up(65_000, 100)], PRICER, 0); // fee-free for clean asserts
  const p = upFair(65_000, PRICER.forward, SVI);

  it('pays the full payout above the strike, nothing below', () => {
    expect(grossPayoffAt(s, 65_500)).toBeCloseTo(100 / p, 6);
    expect(grossPayoffAt(s, 64_500)).toBe(0);
  });

  it('max win = payout − premium, max loss = −premium, breakeven at the strike', () => {
    const st = strategyStats(s);
    expect(st.netCost).toBeCloseTo(100, 6);
    expect(st.maxWin).toBeCloseTo(100 / p - 100, 4);
    expect(st.maxLoss).toBeCloseTo(-100, 6);
    expect(st.breakevens).toEqual([65_000]);
  });

  it('chance of profit ≈ the surface chance the up leg pays', () => {
    const st = strategyStats(s);
    expect(st.chanceOfProfit).toBeCloseTo(p, 6);
  });
});

describe('breakout (long strangle) — two breakevens, wins on the tails', () => {
  const s = buildStrategy([dn(62_000, 50, 'lo'), up(66_000, 50, 'hi')], PRICER, 0);

  it('loses the full premium in the middle, wins on either tail', () => {
    expect(pnlAt(s, 64_000)).toBeCloseTo(-s.netCost, 6); // both lose
    expect(pnlAt(s, 61_000)).toBeGreaterThan(0); // down leg pays
    expect(pnlAt(s, 67_000)).toBeGreaterThan(0); // up leg pays
  });

  it('has exactly two breakevens, bracketing the money', () => {
    const st = strategyStats(s);
    expect(st.breakevens).toEqual([62_000, 66_000]);
    expect(st.maxLoss).toBeCloseTo(-s.netCost, 6);
  });

  it('chance of profit = both tail masses', () => {
    const st = strategyStats(s);
    const tails = dnFair(62_000, PRICER.forward, SVI) + upFair(66_000, PRICER.forward, SVI);
    expect(st.chanceOfProfit).toBeCloseTo(tails, 6);
  });
});

describe('bull ladder — escalating payoff', () => {
  const legs: Leg[] = [up(64_000, 30, 'a'), up(64_500, 30, 'b'), up(65_000, 30, 'c')];
  const s = buildStrategy(legs, PRICER, 0);

  it('gross payoff increases as more rungs finish in the money', () => {
    const low = grossPayoffAt(s, 63_000); // none
    const mid = grossPayoffAt(s, 64_250); // one
    const hi = grossPayoffAt(s, 64_750); // two
    const top = grossPayoffAt(s, 65_500); // all three
    expect(low).toBe(0);
    expect(mid).toBeGreaterThan(low);
    expect(hi).toBeGreaterThan(mid);
    expect(top).toBeGreaterThan(hi);
  });

  it('worst case is the whole premium', () => {
    expect(strategyStats(s).maxLoss).toBeCloseTo(-s.netCost, 6);
  });
});

describe('mark-now curve', () => {
  const s = buildStrategy([up(65_000, 100)], PRICER, 0);
  const reprs = legRepricers(s);

  it('at the current forward, mark ≈ premium value − premium (near breakeven at entry)', () => {
    // A single leg bought at fair: mark value = payout·fair = stake, so P&L ≈ 0.
    expect(markAt(s, reprs, PRICER.forward)).toBeCloseTo(0, 6);
  });

  it('mark rises as the forward rises for a bullish basket', () => {
    expect(markAt(s, reprs, 66_000)).toBeGreaterThan(markAt(s, reprs, 62_000));
  });
});

describe('presetLegs', () => {
  it('breakout straddles the money with a down and an up leg', () => {
    const legs = presetLegs('breakout', 64_000, 500, 10);
    expect(legs).toHaveLength(2);
    expect(legs.some((l) => l.kind === 'binary' && !l.isUp && l.strike === 63_500)).toBe(true);
    expect(legs.some((l) => l.kind === 'binary' && l.isUp && l.strike === 64_500)).toBe(true);
  });

  it('bull ladder is three rising up legs; pin is one range around the money', () => {
    const bull = presetLegs('bull_ladder', 64_000, 500, 10);
    expect(bull).toHaveLength(3);
    expect(bull.every((l) => l.kind === 'binary' && l.isUp)).toBe(true);
    const pin = presetLegs('pin', 64_000, 500, 10);
    expect(pin).toHaveLength(1);
    expect(pin[0]).toMatchObject({ kind: 'range', lower: 63_500, higher: 64_500 });
  });
});
