import { describe, it, expect } from 'vitest';
import {
  quantityForStake,
  knockoutProbability,
  priceMoveToKnockout,
  mintAmountBase,
  minQuantityForBudget,
  MIN_MINT_AMOUNT_BASE,
  POSITION_LOT_BASE,
} from './quote';
import { upFair, type SviFloat } from '@/lib/svi/svi';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 63_000;

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
  it('minQuantity is lot-aligned and sits below the fair-odds quantity', () => {
    const amount = 5_000_000n;
    const fairQty = quantityForStake(amount, 0.502, 2);
    const minQty = minQuantityForBudget(amount, 0.502, 2, 0.05);
    expect(minQty % POSITION_LOT_BASE).toBe(0n);
    expect(minQty).toBeLessThan(fairQty);
    expect(minQty).toBeGreaterThan(0n);
    // ~5% odds slack: min ≈ fair / 1.05 (within a lot of the exact ratio).
    const ratio = Number(fairQty) / Number(minQty);
    expect(ratio).toBeGreaterThan(1.04);
    expect(ratio).toBeLessThan(1.07);
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
