import { describe, it, expect } from 'vitest';
import { recordWalletKind, listWalletMixSince } from './wallet-track-store';

// No KV in the test env → the in-process fallback path. Each test uses distinct
// addresses so the shared module-level store doesn't cross-contaminate.
const DAY = 86_400_000;
const T = 1_800_000_000_000; // fixed "now" for deterministic windows

describe('wallet-track-store (in-process fallback)', () => {
  it('records an address under its kind (lowercased)', async () => {
    await recordWalletKind('0xAAA1', 'google', T);
    const mix = await listWalletMixSince(0);
    expect(mix.google).toContain('0xaaa1');
    expect(mix.slush).not.toContain('0xaaa1');
  });

  it('moves an address to its new kind, never leaving it in two sets', async () => {
    await recordWalletKind('0xBBB2', 'slush', T);
    await recordWalletKind('0xbbb2', 'google', T); // same wallet, re-detected
    const mix = await listWalletMixSince(0);
    expect(mix.google).toContain('0xbbb2');
    expect(mix.slush).not.toContain('0xbbb2');
  });

  it('preserves first-seen time on repeat connects (window stays honest)', async () => {
    await recordWalletKind('0xCCC3', 'other', T - 10 * DAY); // first seen 10d ago
    await recordWalletKind('0xccc3', 'other', T); // reconnect today keeps the old score
    // Still visible in a 7-day window? No — first-seen is 10d ago, not re-stamped.
    const last7 = await listWalletMixSince(T - 7 * DAY);
    expect(last7.other).not.toContain('0xccc3');
    const all = await listWalletMixSince(0);
    expect(all.other).toContain('0xccc3');
  });

  it('windows by first-seen time', async () => {
    await recordWalletKind('0xDDD4', 'google', T - 2 * DAY); // 2 days ago
    await recordWalletKind('0xEEE5', 'google', T - 20 * DAY); // 20 days ago
    const last7 = await listWalletMixSince(T - 7 * DAY);
    expect(last7.google).toContain('0xddd4');
    expect(last7.google).not.toContain('0xeee5');
  });
});
