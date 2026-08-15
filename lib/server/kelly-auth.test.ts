import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { buildSignInMessage } from '@/lib/copilot/memory-auth-message';
import {
  issueNonce,
  verifySignIn,
  mintSession,
  readSession,
  kellyAuthConfigured,
  type SignInProof,
} from './kelly-auth';

// A throwaway signing secret so the gate is "configured" during the test.
const SECRET = 'kelly-auth-test-secret-do-not-use-in-prod';
let prevSecret: string | undefined;
let prevDelegate: string | undefined;

beforeAll(() => {
  prevSecret = process.env.KELLY_MEMORY_SECRET;
  prevDelegate = process.env.WALRUS_DELEGATE_KEY;
  process.env.KELLY_MEMORY_SECRET = SECRET;
  // Ensure the fallback secret doesn't shadow anything unexpectedly in this test.
  delete process.env.WALRUS_DELEGATE_KEY;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env.KELLY_MEMORY_SECRET;
  else process.env.KELLY_MEMORY_SECRET = prevSecret;
  if (prevDelegate !== undefined) process.env.WALRUS_DELEGATE_KEY = prevDelegate;
});

/** Sign a fresh, valid proof for `keypair` (issues + uses a real one-time nonce). */
async function freshProof(keypair: Ed25519Keypair): Promise<SignInProof> {
  const address = keypair.toSuiAddress().toLowerCase();
  const nonce = await issueNonce();
  const issuedAt = new Date().toISOString();
  const message = new TextEncoder().encode(buildSignInMessage({ address, nonce, issuedAt }));
  const { signature } = await keypair.signPersonalMessage(message);
  return { address, nonce, issuedAt, signature };
}

describe('kelly-auth — Sign In with Sui gate', () => {
  it('reports configured when a secret is set', () => {
    expect(kellyAuthConfigured()).toBe(true);
  });

  it('verifies a valid signed nonce and recovers the address', async () => {
    const kp = new Ed25519Keypair();
    const proof = await freshProof(kp);
    const proven = await verifySignIn(proof);
    expect(proven).toBe(kp.toSuiAddress().toLowerCase());
  });

  it('mints a session for a proven address that readSession round-trips', async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress().toLowerCase();
    const token = await mintSession(address);
    expect(token).toBeTruthy();
    expect(await readSession(token)).toBe(address);
  });

  it('rejects a replayed nonce (one-time use)', async () => {
    const kp = new Ed25519Keypair();
    const proof = await freshProof(kp);
    expect(await verifySignIn(proof)).toBe(kp.toSuiAddress().toLowerCase());
    // Same proof again — the nonce was consumed, so it must fail.
    expect(await verifySignIn(proof)).toBeNull();
  });

  it('rejects a nonce that was never issued', async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress().toLowerCase();
    const issuedAt = new Date().toISOString();
    const nonce = 'deadbeef'.repeat(6); // plausible shape, never issued
    const message = new TextEncoder().encode(buildSignInMessage({ address, nonce, issuedAt }));
    const { signature } = await kp.signPersonalMessage(message);
    expect(await verifySignIn({ address, nonce, issuedAt, signature })).toBeNull();
  });

  it('rejects a signature from a different key (impersonation)', async () => {
    const victim = new Ed25519Keypair();
    const attacker = new Ed25519Keypair();
    const address = victim.toSuiAddress().toLowerCase(); // claims to be the victim
    const nonce = await issueNonce();
    const issuedAt = new Date().toISOString();
    const message = new TextEncoder().encode(buildSignInMessage({ address, nonce, issuedAt }));
    const { signature } = await attacker.signPersonalMessage(message); // but signs with attacker's key
    expect(await verifySignIn({ address, nonce, issuedAt, signature })).toBeNull();
  });

  it('rejects a stale proof (issuedAt too old)', async () => {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress().toLowerCase();
    const nonce = await issueNonce();
    const issuedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    const message = new TextEncoder().encode(buildSignInMessage({ address, nonce, issuedAt }));
    const { signature } = await kp.signPersonalMessage(message);
    expect(await verifySignIn({ address, nonce, issuedAt, signature })).toBeNull();
  });

  it('rejects a tampered session token', async () => {
    const kp = new Ed25519Keypair();
    const token = await mintSession(kp.toSuiAddress().toLowerCase());
    expect(await readSession(token! + 'x')).toBeNull();
    expect(await readSession('not-a-jwt')).toBeNull();
    expect(await readSession(undefined)).toBeNull();
  });
});
