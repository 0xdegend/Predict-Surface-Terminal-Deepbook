import { describe, it, expect } from 'vitest';
import { fundingSplit } from './funding';

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
