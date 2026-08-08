import { describe, it, expect } from 'vitest';
import {
  generateSession,
  sessionAddressOf,
  saveSession,
  loadSession,
  clearSession,
  sessionStorageKey,
  isSessionLive,
  buildAuthorizeSessionTx,
  buildRevokeSessionTx,
  buildSweepSessionGasTx,
  SESSION_DURATIONS_MS,
  DEFAULT_SESSION_DURATION,
} from './session';
import { predictV2Config } from '@/config/predict';

const WRAPPER = '0x1111111111111111111111111111111111111111111111111111111111111111';

describe('session key lifecycle', () => {
  it('generates a non-extractable key with a valid Sui address', async () => {
    const s = await generateSession();
    const addr = sessionAddressOf(s);
    expect(addr).toMatch(/^0x[0-9a-f]{64}$/);
    // Non-extractable: the exported private key handle cannot be exported by JWK.
    expect(s.export().privateKey.extractable).toBe(false);
  });

  it('two sessions have distinct addresses', async () => {
    const a = sessionAddressOf(await generateSession());
    const b = sessionAddressOf(await generateSession());
    expect(a).not.toBe(b);
  });

  it('persist -> restore round-trips the same address and can still sign', async () => {
    const owner = '0xAAA0000000000000000000000000000000000000000000000000000000000001';
    const signer = await generateSession();
    const saved = await saveSession(owner, signer);
    const loaded = await loadSession(owner);
    expect(loaded).not.toBeNull();
    expect(loaded!.address).toBe(saved.address);
    expect(loaded!.address).toBe(sessionAddressOf(signer));
    const sig = await loaded!.signer.sign(new Uint8Array([1, 2, 3, 4]));
    expect(sig.length).toBeGreaterThan(0);
  });

  it('clear removes the stored session', async () => {
    const owner = '0xBBB0000000000000000000000000000000000000000000000000000000000002';
    await saveSession(owner, await generateSession());
    expect(await loadSession(owner)).not.toBeNull();
    await clearSession(owner);
    expect(await loadSession(owner)).toBeNull();
  });

  it('unknown owner has no session', async () => {
    expect(await loadSession('0xdeadbeef')).toBeNull();
  });
});

describe('sessionStorageKey', () => {
  it('is owner-lowercased and deployment-scoped', () => {
    const k = sessionStorageKey('0xABCDEF');
    expect(k).toBe(`0xabcdef::${predictV2Config.packages.predict}`);
  });
  it('differs per owner', () => {
    expect(sessionStorageKey('0x1')).not.toBe(sessionStorageKey('0x2'));
  });
});

describe('isSessionLive', () => {
  const now = 1_000_000;
  it('true only when authorized and unexpired', () => {
    expect(isSessionLive(now + 10_000, now)).toBe(true);
    expect(isSessionLive(now - 1, now)).toBe(false);
    expect(isSessionLive(null, now)).toBe(false);
  });
});

describe('durations', () => {
  it('default is 24h and within the 30-day cap', () => {
    expect(DEFAULT_SESSION_DURATION).toBe('24h');
    expect(SESSION_DURATIONS_MS['24h']).toBe(86_400_000);
    for (const ms of Object.values(SESSION_DURATIONS_MS)) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(30 * 86_400_000);
    }
  });
});

describe('PTB builders target the sessions package', () => {
  const call = (cmd: unknown) => (cmd as { MoveCall?: { package: string; module: string; function: string } }).MoveCall;

  it('authorize_session (with deposit) builds deposit + authorize on the sessions module', () => {
    const tx = buildAuthorizeSessionTx({
      wrapperId: WRAPPER,
      sessionAddress: WRAPPER,
      durationMs: SESSION_DURATIONS_MS['24h'],
      depositBase: 50_000_000n,
    });
    const calls = tx.getData().commands.map(call).filter(Boolean) as { package: string; module: string; function: string }[];
    const authorize = calls.find((c) => c.function === 'authorize_session');
    expect(authorize).toBeDefined();
    expect(authorize!.package).toBe(predictV2Config.packages.sessions);
    expect(authorize!.module).toBe('sessions');
    // deposit rode along on the account package (generate_auth + deposit_funds)
    expect(calls.some((c) => c.function === 'deposit_funds' && c.package === predictV2Config.packages.account)).toBe(true);
  });

  it('revoke_session targets the sessions module', () => {
    const tx = buildRevokeSessionTx(WRAPPER, WRAPPER);
    const c = call(tx.getData().commands[0])!;
    expect(c.package).toBe(predictV2Config.packages.sessions);
    expect(c.module).toBe('sessions');
    expect(c.function).toBe('revoke_session');
  });
});

describe('buildSweepSessionGasTx', () => {
  it('is a single TransferObjects of the gas coin (send-all-SUI idiom)', () => {
    const owner = '0xCCC0000000000000000000000000000000000000000000000000000000000003';
    const cmds = buildSweepSessionGasTx(owner).getData().commands;
    expect(cmds).toHaveLength(1);
    const transfer = (cmds[0] as { TransferObjects?: { objects: { $kind?: string }[] } }).TransferObjects;
    expect(transfer).toBeDefined();
    // The lone object being transferred is the gas coin (its post-gas remainder).
    expect(transfer!.objects.some((o) => o.$kind === 'GasCoin')).toBe(true);
  });
});
