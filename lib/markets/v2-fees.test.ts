import { describe, it, expect } from 'vitest';
import {
  feeRatesFor,
  grossPayoutMultiple,
  netPayoutMultiple,
  breakevenProb,
  breakevenEdgePts,
  netEdgePts,
  netEvPct,
  feeOnStake,
  hasFees,
  NO_FEES,
  type FeeRates,
} from './v2-fees';
import type { V2Market } from '@/lib/api/v2/types';

/** The live 8-06 config: base_fee 2% of notional, Skew router at 50 bps of stake. */
const LIVE: FeeRates = { notional: 0.02, stake: 0.005 };
const market = (base_fee: string) => ({ base_fee }) as Pick<V2Market, 'base_fee'>;

describe('feeRatesFor', () => {
  it('reads base_fee off the market as a 1e9-scaled fraction of notional', () => {
    expect(feeRatesFor(market('20000000')).notional).toBeCloseTo(0.02, 12);
    expect(feeRatesFor(market('0')).notional).toBe(0);
  });

  it('converts the Skew rate from bps of stake', () => {
    expect(feeRatesFor(market('0'), 50).stake).toBeCloseTo(0.005, 12);
    expect(feeRatesFor(market('0'), 0).stake).toBe(0);
  });

  it('charges nothing without a market, so an unloaded page never overstates a payout', () => {
    expect(feeRatesFor(null)).toEqual(NO_FEES);
    expect(feeRatesFor(undefined, 50).notional).toBe(0);
  });

  it('never returns a negative rate', () => {
    expect(feeRatesFor(market('-1000'), -50).notional).toBe(0);
    expect(feeRatesFor(market('0'), -50).stake).toBe(0);
  });
});

describe('netPayoutMultiple', () => {
  it('equals the gross multiple when nothing is charged', () => {
    for (const p of [0.18, 0.5, 0.82]) {
      expect(netPayoutMultiple(p, NO_FEES)).toBeCloseTo(grossPayoutMultiple(p), 12);
    }
  });

  it('is always below gross once a fee is charged', () => {
    for (const p of [0.05, 0.18, 0.5, 0.82, 0.95]) {
      expect(netPayoutMultiple(p, LIVE)).toBeLessThan(grossPayoutMultiple(p));
    }
  });

  it('bites HARDEST on longshots, because the fee is charged on notional', () => {
    // The whole reason a gross quote is misleading: notional scales as 1/p, so the
    // fee does too. An 18% longshot loses more than twice the share of its return
    // that an even-money bet does.
    const lossAt = (p: number) => 1 - netPayoutMultiple(p, LIVE) / grossPayoutMultiple(p);
    expect(lossAt(0.5)).toBeCloseTo(0.0431, 3); // ~4% of the return
    expect(lossAt(0.18)).toBeCloseTo(0.1041, 3); // ~10% of the return
    expect(lossAt(0.18)).toBeGreaterThan(2 * lossAt(0.82));
  });

  it('turns the ladder 5.56x longshot into the 4.98x a trader actually gets', () => {
    expect(grossPayoutMultiple(0.18)).toBeCloseTo(5.556, 3);
    expect(netPayoutMultiple(0.18, LIVE)).toBeCloseTo(4.978, 3);
  });

  it('is 0 rather than Infinity at an unusable probability', () => {
    expect(netPayoutMultiple(0, NO_FEES)).toBe(0);
    expect(grossPayoutMultiple(0)).toBe(0);
  });
});

describe('breakevenProb / breakevenEdgePts', () => {
  it('is the price itself when nothing is charged', () => {
    expect(breakevenProb(0.4, NO_FEES)).toBeCloseTo(0.4, 12);
    expect(breakevenEdgePts(0.4, NO_FEES)).toBeCloseTo(0, 12);
  });

  it('sits above the price by the fee, at every strike', () => {
    for (const p of [0.18, 0.5, 0.82]) {
      expect(breakevenProb(p, LIVE)).toBeGreaterThan(p);
    }
  });

  it('costs about 2 to 2.5 points of edge across the whole quotable band', () => {
    // The finding that condemns the old scanner default: the fee floor is roughly
    // flat in POINTS, and it is right on top of the 2-point threshold the scanner
    // used to admit rows.
    expect(breakevenEdgePts(0.18, LIVE)).toBeCloseTo(2.09, 2);
    expect(breakevenEdgePts(0.5, LIVE)).toBeCloseTo(2.25, 2);
    expect(breakevenEdgePts(0.82, LIVE)).toBeCloseTo(2.41, 2);
  });

  it('makes a bet EV-neutral exactly at breakeven, positive above, negative below', () => {
    const p = 0.5;
    const be = breakevenProb(p, LIVE);
    expect(netEvPct(be, p, LIVE)).toBeCloseTo(0, 10);
    expect(netEvPct(be + 0.02, p, LIVE)).toBeGreaterThan(0);
    expect(netEvPct(be - 0.02, p, LIVE)).toBeLessThan(0);
  });
});

describe('netEdgePts', () => {
  it('is the gross edge with the fee floor removed', () => {
    const implied = 0.5;
    const empirical = 0.56; // +6 points gross
    const gross = (empirical - implied) * 100;
    expect(gross).toBeCloseTo(6, 10);
    expect(netEdgePts(empirical, implied, LIVE)).toBeCloseTo(gross - breakevenEdgePts(implied, LIVE), 10);
  });

  it('turns the old scanner threshold into the losing trade it always was', () => {
    // A row the scanner used to float at exactly its +2pt cutoff.
    const implied = 0.5;
    const empirical = 0.52;
    expect((empirical - implied) * 100).toBeCloseTo(2, 10); // admitted, and called value
    expect(netEdgePts(empirical, implied, LIVE)).toBeLessThan(0); // actually loses money
    expect(netEvPct(empirical, implied, LIVE)).toBeLessThan(0);
  });

  it('agrees with netEvPct on the sign, at every strike', () => {
    for (const implied of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const empirical of [0.05, 0.25, 0.5, 0.75, 0.99]) {
        expect(Math.sign(netEdgePts(empirical, implied, LIVE))).toBe(
          Math.sign(Number(netEvPct(empirical, implied, LIVE).toFixed(9))),
        );
      }
    }
  });
});

describe('feeOnStake', () => {
  it('matches the mint path: base_fee on notional plus the router on stake', () => {
    // $100 at 50% is $200 of notional → $4 trade fee, plus 0.5% of $100 = $0.50.
    expect(feeOnStake(100, 0.5, LIVE)).toBeCloseTo(4.5, 10);
  });

  it('grows as the odds lengthen, because notional does', () => {
    expect(feeOnStake(100, 0.1, LIVE)).toBeGreaterThan(feeOnStake(100, 0.5, LIVE));
  });

  it('is 0 for an unusable stake or probability', () => {
    expect(feeOnStake(0, 0.5, LIVE)).toBe(0);
    expect(feeOnStake(100, 0, LIVE)).toBe(0);
    expect(feeOnStake(-10, 0.5, LIVE)).toBe(0);
  });
});

describe('hasFees', () => {
  it('is false only when nothing at all is charged', () => {
    expect(hasFees(NO_FEES)).toBe(false);
    expect(hasFees({ notional: 0, stake: 0.005 })).toBe(true);
    expect(hasFees({ notional: 0.02, stake: 0 })).toBe(true);
  });
});
