import { describe, it, expect } from 'vitest';
import { isRealPayoutMarker } from './grant-store';

describe('isRealPayoutMarker — real payout vs stale/false marker', () => {
  it('accepts a genuine base58 tx digest (a confirmed payout)', () => {
    for (const digest of [
      '8bUT7UZrheQp1w7jT7Ht5FCmErwpUXs3JEokyVsVoi9B', // 44-char testnet digest
      'FuuFTF5gBzMzGewinTUWj1at1r5Fe9ZAW27HMLjwLSsw',
      '4qZJwVVazznDSWrmtGsSCMSwCLioPpdxbCxGEmQwFBdm',
    ]) {
      expect(isRealPayoutMarker(digest), digest).toBe(true);
    }
  });

  it("rejects the old balance-gate sentinel '1' (a false 'funded' flag)", () => {
    expect(isRealPayoutMarker('1')).toBe(false);
  });

  it('rejects empty / missing markers', () => {
    expect(isRealPayoutMarker(null)).toBe(false);
    expect(isRealPayoutMarker(undefined)).toBe(false);
    expect(isRealPayoutMarker('')).toBe(false);
  });

  it('rejects other short or non-base58 junk so it heals instead of blocking', () => {
    for (const junk of ['true', '0', 'done', 'granted', '0xdeadbeef' /* has 0/x, too short */]) {
      expect(isRealPayoutMarker(junk), junk).toBe(false);
    }
  });
});
