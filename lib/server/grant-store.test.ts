import { describe, it, expect } from 'vitest';
import {
  isRealPayoutMarker,
  grantScope,
  getGranted,
  markGranted,
  clearGranted,
  hasGranted,
  listFaucetClaimers,
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

// The 9-12 regression: the faucet's "already funded" ledger used to be keyed by address
// alone, so when the deployment swapped its collateral (dusdc::DUSDC -> usdc::USDC) every
// wallet the faucet had ever funded was refused the new grant while holding a dead coin.
// Markers are now scoped per collateral, which is what keeps those two questions apart.
describe('grantScope — one ledger per collateral coin', () => {
  const DUSDC = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
  const USDC = '0xc028557a1ed49e42ed091e115aedefd70a442b184c18fbec5c48d5b6c0b8c184::usdc::USDC';

  it('gives the 8-21 and 9-12 collaterals different scopes', () => {
    expect(grantScope(DUSDC)).not.toBe(grantScope(USDC));
  });

  it('is readable enough to diagnose from a raw key', () => {
    // Spelled out per network, so these stay true whatever chain the build points at.
    expect(grantScope(USDC, 'testnet')).toBe('usdc-c02855');
    expect(grantScope(DUSDC, 'testnet')).toBe('dusdc-e95040');
  });

  it('separates two packages that reuse the same module name', () => {
    expect(grantScope('0xaaaa1111::usdc::USDC')).not.toBe(grantScope('0xbbbb2222::usdc::USDC'));
  });

  it('stays a single key segment so the address stays parseable', () => {
    for (const t of [DUSDC, USDC, '', 'malformed', '0xabc::x::Y']) {
      expect(grantScope(t), t).not.toContain(':');
      expect(grantScope(t), t).not.toBe('');
    }
  });

  it('a payout in the OLD coin does not block a grant of the NEW one', async () => {
    const addr = '0xmigrate-a';
    const digest = '8bUT7UZrheQp1w7jT7Ht5FCmErwpUXs3JEokyVsVoi9B';
    await markGranted(grantScope(DUSDC), addr, digest);

    // the dead coin still remembers paying them...
    expect(await getGranted(grantScope(DUSDC), addr)).toBe(digest);
    // ...but the live coin has never funded them, so the route pays.
    expect(await getGranted(grantScope(USDC), addr)).toBeNull();
    expect(await hasGranted(grantScope(USDC), addr)).toBe(false);
  });

  it('still refuses a second grant of the SAME coin', async () => {
    const addr = '0xmigrate-b';
    const digest = 'FuuFTF5gBzMzGewinTUWj1at1r5Fe9ZAW27HMLjwLSsw';
    await markGranted(grantScope(USDC), addr, digest);
    expect(isRealPayoutMarker(await getGranted(grantScope(USDC), addr))).toBe(true);
  });

  it('clearing one scope leaves the other intact', async () => {
    const addr = '0xmigrate-c';
    await markGranted(grantScope(DUSDC), addr, 'oldmarker');
    await markGranted(grantScope(USDC), addr, 'newmarker');
    await clearGranted(grantScope(USDC), addr);
    expect(await getGranted(grantScope(USDC), addr)).toBeNull();
    expect(await getGranted(grantScope(DUSDC), addr)).toBe('oldmarker');
  });

  it('the leaderboard still counts a claimer once across both scopes', async () => {
    const addr = '0xClaimer-D';
    await markGranted(grantScope(DUSDC, 'testnet'), addr, 'old');
    await markGranted(grantScope(USDC, 'testnet'), addr, 'new');
    const claimers = await listFaucetClaimers('testnet');
    expect(claimers.filter((c) => c === addr.toLowerCase())).toHaveLength(1);
  });
});

// Added 2026-09-24. On the day mainnet went live, 34 testnet grant wallets appeared on the
// freshly-empty mainnet Skew board, each carrying a participation point, on a chain where
// nobody had traded yet — so the board read as busy when it should have read as day one.
// The markers were correctly keyed by collateral, and a coin type is chain-specific, but
// `listFaucetClaimers` threw the scope away and enumerated every marker in the store. Same
// class of bug as the leaderboard carryover seeds, in the one overlay that guard missed.
describe('grantScope — one ledger per network', () => {
  const TESTNET_USDC = '0xc028557a1ed49e42ed091e115aedefd70a442b184c18fbec5c48d5b6c0b8c184::usdc::USDC';
  const MAINNET_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

  it('leaves the testnet spelling untouched, so no existing wallet is re-offered a grant', () => {
    expect(grantScope(TESTNET_USDC, 'testnet')).toBe('usdc-c02855');
  });

  it('gives mainnet its own ledger, and a single key segment like every other scope', () => {
    expect(grantScope(MAINNET_USDC, 'mainnet')).toBe('mainnet-usdc-dba346');
    expect(grantScope(MAINNET_USDC, 'mainnet')).not.toContain(':');
  });

  it('separates the two chains even for a coin that looks identical', () => {
    expect(grantScope(TESTNET_USDC, 'mainnet')).not.toBe(grantScope(TESTNET_USDC, 'testnet'));
  });

  it('keeps a testnet onboard off the mainnet board', async () => {
    const addr = '0xnetgate-a';
    await markGranted(grantScope(TESTNET_USDC, 'testnet'), addr, 'testnetpayout');
    expect(await listFaucetClaimers('testnet')).toContain(addr.toLowerCase());
    expect(await listFaucetClaimers('mainnet')).not.toContain(addr.toLowerCase());
  });

  it('and a mainnet onboard off the testnet board', async () => {
    const addr = '0xnetgate-b';
    await markGranted(grantScope(MAINNET_USDC, 'mainnet'), addr, 'mainnetpayout');
    expect(await listFaucetClaimers('mainnet')).toContain(addr.toLowerCase());
    expect(await listFaucetClaimers('testnet')).not.toContain(addr.toLowerCase());
  });

  it('counts a wallet that onboarded on both chains once on each', async () => {
    const addr = '0xnetgate-c';
    await markGranted(grantScope(TESTNET_USDC, 'testnet'), addr, 'one');
    await markGranted(grantScope(MAINNET_USDC, 'mainnet'), addr, 'two');
    const only = (list: string[]) => list.filter((c) => c === addr.toLowerCase());
    expect(only(await listFaucetClaimers('testnet'))).toHaveLength(1);
    expect(only(await listFaucetClaimers('mainnet'))).toHaveLength(1);
  });

  it('a legacy un-scoped marker still reads as testnet', async () => {
    const addr = '0xnetgate-d';
    // A marker carrying no network segment, the shape everything written before today has.
    await markGranted('', addr, 'legacy');
    expect(await listFaucetClaimers('mainnet')).not.toContain(addr.toLowerCase());
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
