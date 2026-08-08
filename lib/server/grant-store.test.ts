import { describe, it, expect } from 'vitest';
import {
  isRealPayoutMarker,
  acquireGasDripLock,
  releaseGasDripLock,
  recentlyDripped,
  markDripped,
  gasDripDailyCount,
} from './grant-store';

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

// Session-gas drip helpers (in-process fallback path — no Redis in the test env).
// Unique addresses per test keep the module-level maps from bleeding across cases.
describe('session-gas drip store — lock / cooldown / daily count', () => {
  it('the in-flight lock is exclusive until released', async () => {
    const addr = '0xlock-a';
    expect(await acquireGasDripLock(addr)).toBe(true);
    expect(await acquireGasDripLock(addr)).toBe(false); // held → concurrent drip refused
    await releaseGasDripLock(addr);
    expect(await acquireGasDripLock(addr)).toBe(true); // free again
    await releaseGasDripLock(addr);
  });

  it('a key reads as recently dripped only after a drip is recorded', async () => {
    const addr = '0xcooldown-b';
    expect(await recentlyDripped(addr)).toBe(false);
    await markDripped(addr);
    expect(await recentlyDripped(addr)).toBe(true); // cooldown now active
  });

  it('recording a drip bumps the global daily count', async () => {
    const before = await gasDripDailyCount();
    await markDripped('0xdaily-c');
    expect(await gasDripDailyCount()).toBe(before + 1);
  });
});
