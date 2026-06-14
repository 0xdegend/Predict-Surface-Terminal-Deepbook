import { describe, it, expect } from 'vitest';
import { fundingSplit, skewFee, feeRouterPayment } from './funding';

describe('fundingSplit', () => {
  it('buffers the cost by 2%', () => {
    // free balance = 0 → deposit the whole buffered cost
    expect(fundingSplit(1_000_000n, 0n)).toEqual({
      depositAmount: 1_020_000n,
      buffered: 1_020_000n,
    });
  });

  it('covers the buffered cost from free balance first, deposits only the shortfall', () => {
    // buffered = 1_020_000; free = 500_000 → wallet covers the rest
    expect(fundingSplit(1_000_000n, 500_000n).depositAmount).toBe(520_000n);
  });

  it('deposits nothing when free balance already covers the buffered cost', () => {
    expect(fundingSplit(1_000_000n, 2_000_000n).depositAmount).toBe(0n);
  });

  it('is exact at the buffered-cost boundary', () => {
    // free exactly equals buffered cost → no deposit
    expect(fundingSplit(1_000_000n, 1_020_000n).depositAmount).toBe(0n);
  });
});

describe('skewFee', () => {
  it('is 1% of cost at 100 bps', () => {
    expect(skewFee(1_000_000n, 100)).toBe(10_000n);
  });
  it('is zero when the rate is zero', () => {
    expect(skewFee(1_000_000n, 0)).toBe(0n);
  });
  it('scales with the rate', () => {
    expect(skewFee(2_000_000n, 150)).toBe(30_000n); // 1.5% of 2.0
  });
});

describe('feeRouterPayment', () => {
  it('shows the nominal fee on the quoted cost, but funds fee+deposit (both buffered)', () => {
    // free = 0 → deposit the buffered cost (1.02), fee buffered on the buffered cost.
    const r = feeRouterPayment(1_000_000n, 0n, 100);
    expect(r.fee).toBe(10_000n); // 1% of 1.0 — the figure shown to the user
    expect(r.depositAmount).toBe(1_020_000n); // 1.02 buffered cost
    expect(r.paymentAmount).toBe(1_020_000n + 10_200n); // deposit + fee on buffered cost
  });

  it('still covers the fee when the free balance already funds the bet', () => {
    // free covers the buffered cost → depositAmount 0, but payment still carries the fee.
    const r = feeRouterPayment(1_000_000n, 5_000_000n, 100);
    expect(r.depositAmount).toBe(0n);
    expect(r.paymentAmount).toBe(10_200n); // just the buffered fee
  });

  it('charges nothing extra at 0 bps', () => {
    const r = feeRouterPayment(1_000_000n, 0n, 0);
    expect(r.fee).toBe(0n);
    expect(r.paymentAmount).toBe(1_020_000n); // == deposit only
  });
});
