import { describe, it, expect } from 'vitest';
import {
  quantityForStake,
  winPayout,
  knockoutProbability,
  priceMoveToKnockout,
  mintAmountBase,
  minQuantityForBudget,
  MIN_MINT_AMOUNT_BASE,
  MAX_PAYOUT_SHRINK,
  POSITION_LOT_BASE,
} from './quote';
import { upFair, type SviFloat } from '@/lib/svi/svi';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 63_000;

describe('winPayout (what a win actually pays)', () => {
  it('at 1× pays the full max-payout quantity (floor 0)', () => {
    expect(winPayout(6_500_000n, 0.769, 1)).toBe(6_500_000n);
  });

  it('at 2× pays qty − floor, matching the on-chain settled payout', () => {
    // Verified on-chain: qty $12.72, entry 78.59%, 2× → floor ~$5.00 → payout $7.72.
    const win = winPayout(12_720_000n, 0.785915858, 2);
    expect(Number(win) / 1e6).toBeCloseTo(7.72, 1);
    expect(win).toBeLessThan(12_720_000n); // NOT the full qty (the overstatement bug)
    // second real order: qty $10.71, entry 93.33%, 2× → $5.71.
    expect(Number(winPayout(10_710_000n, 0.933312689, 2)) / 1e6).toBeCloseTo(5.71, 1);
  });

  it('never goes negative', () => {
    expect(winPayout(1_000_000n, 0.99, 3)).toBeGreaterThanOrEqual(0n);
  });
});

describe('quantityForStake', () => {
  it('at 1x, cost ≈ stake (quantity = stake / prob)', () => {
    const stakeBase = 10_000_000n; // $10
    const q = quantityForStake(stakeBase, 0.5, 1);
    expect(Number(q)).toBeCloseTo(20_000_000, -3); // $10 / 0.5 = $20 max payout
  });
  it('leverage scales the controllable size', () => {
    const q1 = quantityForStake(10_000_000n, 0.5, 1);
    const q3 = quantityForStake(10_000_000n, 0.5, 3);
    expect(Number(q3)).toBeCloseTo(Number(q1) * 3, -3);
  });
  it('always lands on the lot grid (order::assert_valid_quantity requires it)', () => {
    // 50.2% at 2x — the raw solve (3,984,063.7…) is nowhere near lot-aligned.
    const q = quantityForStake(1_050_000n, 0.502, 2);
    expect(q % POSITION_LOT_BASE).toBe(0n);
    expect(q).toBeGreaterThan(0n);
    // Awkward probability, 1x.
    expect(quantityForStake(5_000_000n, 0.337, 1) % POSITION_LOT_BASE).toBe(0n);
  });
});

describe('budget mint sizing (mint_exact_amount)', () => {
  it('a $1.00 stake gets the $1.01 minimum budget (lot-rounding headroom)', () => {
    expect(mintAmountBase(1_000_000n)).toBe(MIN_MINT_AMOUNT_BASE);
  });
  it('stakes at/above $1.01 pass through as the budget', () => {
    expect(mintAmountBase(1_010_000n)).toBe(1_010_000n);
    expect(mintAmountBase(5_000_000n)).toBe(5_000_000n);
  });
  it('minQuantity is lot-aligned and is the quoted payout minus the shrink tolerance', () => {
    const quoted = quantityForStake(5_000_000n, 0.502, 2);
    const minQty = minQuantityForBudget(quoted);
    expect(minQty % POSITION_LOT_BASE).toBe(0n);
    expect(minQty).toBeLessThan(quoted);
    expect(minQty).toBeGreaterThan(0n);
    // Guaranteed floor = quoted × (1 − MAX_PAYOUT_SHRINK), within one lot.
    const expected = Number(quoted) * (1 - MAX_PAYOUT_SHRINK);
    expect(Math.abs(Number(minQty) - expected)).toBeLessThanOrEqual(Number(POSITION_LOT_BASE));
  });
  it('a custom shrink of 0 keeps (almost) the full quoted payout', () => {
    const quoted = 4_000_000n;
    expect(minQuantityForBudget(quoted, 0)).toBe(quoted);
  });
});

describe('knockoutProbability', () => {
  const LTV = 0.85;
  it('has no barrier at 1x (returns null)', () => {
    expect(knockoutProbability(0.5, 1, LTV)).toBeNull();
  });
  it('matches p·(1 − 1/L)/ltv', () => {
    // 2x @ entry 50%: 0.5 · 0.5 / 0.85 ≈ 0.2941
    expect(knockoutProbability(0.5, 2, LTV)!).toBeCloseTo((0.5 * 0.5) / 0.85, 6);
    // 3x @ entry 50%: 0.5 · (2/3) / 0.85 ≈ 0.3922
    expect(knockoutProbability(0.5, 3, LTV)!).toBeCloseTo((0.5 * (2 / 3)) / 0.85, 6);
  });
  it('higher leverage raises the barrier (knocks out at a higher chance = sooner)', () => {
    expect(knockoutProbability(0.5, 3, LTV)!).toBeGreaterThan(knockoutProbability(0.5, 2, LTV)!);
  });
});

describe('priceMoveToKnockout', () => {
  const LTV = 0.85;
  // An UP strike a touch below the forward → entry chance well inside (0,1).
  const STRIKE = 62_500;

  it('is null at 1x (no barrier)', () => {
    expect(priceMoveToKnockout(STRIKE, FORWARD, SVI, true, 1, LTV)).toBeNull();
  });

  it('higher leverage → smaller adverse-move buffer (less room before knockout)', () => {
    const b2 = priceMoveToKnockout(STRIKE, FORWARD, SVI, true, 2, LTV)!;
    const b3 = priceMoveToKnockout(STRIKE, FORWARD, SVI, true, 3, LTV)!;
    expect(b2).toBeGreaterThan(0);
    expect(b3).toBeGreaterThan(0);
    expect(b3).toBeLessThan(b2);
  });

  it('the solved forward actually prices at the knockout barrier (round-trip)', () => {
    const move = priceMoveToKnockout(STRIKE, FORWARD, SVI, true, 2, LTV)!;
    const entryProb = upFair(STRIKE, FORWARD, SVI);
    const koProb = knockoutProbability(entryProb, 2, LTV)!;
    // UP → adverse move is a price fall.
    const fKo = FORWARD * (1 - move);
    expect(upFair(STRIKE, fKo, SVI)).toBeCloseTo(koProb, 3);
  });

  it('DOWN bet: adverse move is a price RISE that prices at the barrier', () => {
    const downStrike = 63_500; // above the forward → a real DOWN chance
    const move = priceMoveToKnockout(downStrike, FORWARD, SVI, false, 2, LTV)!;
    const entryProb = 1 - upFair(downStrike, FORWARD, SVI);
    const koProb = knockoutProbability(entryProb, 2, LTV)!;
    const fKo = FORWARD * (1 + move); // price rose
    expect(1 - upFair(downStrike, fKo, SVI)).toBeCloseTo(koProb, 3);
  });
});
