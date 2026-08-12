import { describe, it, expect } from 'vitest';
import {
  getRewardClaim,
  hasRewardClaim,
  isRealRewardPayout,
  markRewardClaimed,
  acquireRewardLock,
  releaseRewardLock,
  listRewardClaimers,
} from './reward-store';

// No KV in the test env → in-process fallback. Distinct addresses per test.
const C = 'test-campaign';

describe('reward-store (in-process fallback)', () => {
  it('marks a claim with the payout digest and reads it back', async () => {
    expect(await hasRewardClaim(C, '0xAAA1')).toBe(false);
    await markRewardClaimed(C, '0xAAA1', '0xdigest_aaaaaaaa');
    expect(await hasRewardClaim(C, '0xaaa1')).toBe(true); // case-insensitive
    expect(await getRewardClaim(C, '0xAAA1')).toBe('0xdigest_aaaaaaaa');
  });

  it('treats only a real digest as a payout (not the legacy "1" sentinel)', () => {
    expect(isRealRewardPayout('0xdeadbeef1234')).toBe(true);
    expect(isRealRewardPayout('1')).toBe(false);
    expect(isRealRewardPayout(null)).toBe(false);
  });

  it('lock is exclusive until released (kills the double-pay race)', async () => {
    expect(await acquireRewardLock(C, '0xBBB2')).toBe(true);
    expect(await acquireRewardLock(C, '0xbbb2')).toBe(false); // held
    await releaseRewardLock(C, '0xBBB2');
    expect(await acquireRewardLock(C, '0xBBB2')).toBe(true); // free again
  });

  it('namespaces by campaign — a claim in one campaign does not block another', async () => {
    await markRewardClaimed('camp-1', '0xCCC3', '0xdig_ccc3');
    expect(await hasRewardClaim('camp-1', '0xCCC3')).toBe(true);
    expect(await hasRewardClaim('camp-2', '0xCCC3')).toBe(false);
  });

  it('lists claimers of a campaign', async () => {
    await markRewardClaimed('camp-list', '0xDDD4', '0xdig_ddd4');
    const claimers = await listRewardClaimers('camp-list');
    expect(claimers).toContain('0xddd4');
  });
});
