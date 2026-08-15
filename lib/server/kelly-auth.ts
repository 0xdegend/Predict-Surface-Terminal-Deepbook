/**
 * lib/server/kelly-auth.ts — the wallet-ownership gate for Kelly's memory API.
 *
 * Kelly's memories are per-wallet, and the delegate key that decrypts them is server-only,
 * so the recall/remember routes MUST prove the caller controls the wallet whose memories
 * they're touching. This is "Sign In with Sui": the trader signs a one-time nonce (a plain
 * personal message, never a transaction), the server verifies the signature recovers the
 * address, and we hand back a short-lived HttpOnly session cookie. Subsequent memory calls
 * ride that cookie, so passive continuity + auto-remember work with no per-call popup.
 *
 * SERVER-ONLY (jose secret, nonce store, gRPC verify client). Never import into a client bundle.
 *
 * Secret: KELLY_MEMORY_SECRET, falling back to WALRUS_DELEGATE_KEY (already a stable,
 * high-entropy server secret) so the operator needn't add another env. With neither set,
 * auth can't run and the memory routes stay dark (they already require the delegate key).
 *
 * Import only from server code (route handlers): it reads server-only env + a signing secret.
 */
import { SignJWT, jwtVerify } from 'jose';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { kv } from '@/lib/server/kv';
import { predictV2Config } from '@/config/predict';
import { walrusConfig } from '@/config/walrus';
import { buildSignInMessage, MEMORY_SIGNIN_TTL_MS, type SignInFields } from '@/lib/copilot/memory-auth-message';

/** The HttpOnly session cookie name. */
export const KELLY_AUTH_COOKIE = 'kelly_mem';

/** Session lifetime — a returning trader signs in about once a week. */
const SESSION_TTL_S = 7 * 24 * 60 * 60;
/** Accept a little clock skew when checking the client's issuedAt stamp. */
const CLOCK_SKEW_MS = 60_000;

function secretKey(): Uint8Array | null {
  const raw = process.env.KELLY_MEMORY_SECRET || process.env.WALRUS_DELEGATE_KEY;
  return raw ? new TextEncoder().encode(raw) : null;
}

/** True when the gate can run (a signing secret is configured). */
export function kellyAuthConfigured(): boolean {
  return secretKey() !== null;
}

/* ----------------------------- nonce store ------------------------------- */
// One-time nonces so a captured sign-in signature can never be replayed. Uses the shared
// KV when configured (survives cold starts / multiple instances); otherwise an in-process
// Map with TTL — fine for local dev / a single instance.

const NONCE_TTL_S = 300;
const _localNonces = new Map<string, number>(); // nonce -> expiry ms

function pruneLocalNonces(now: number): void {
  for (const [n, exp] of _localNonces) if (exp <= now) _localNonces.delete(n);
}

/** Mint a fresh one-time nonce and remember it (KV or in-process). */
export async function issueNonce(): Promise<string> {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  if (kv) {
    await kv.set(`kelly:nonce:${nonce}`, 1, { ex: NONCE_TTL_S });
  } else {
    pruneLocalNonces(Date.now());
    _localNonces.set(nonce, Date.now() + NONCE_TTL_S * 1000);
  }
  return nonce;
}

/** Consume a nonce, returning true exactly once (false if unknown, expired, or reused). */
async function consumeNonce(nonce: string): Promise<boolean> {
  if (!nonce) return false;
  if (kv) {
    // Atomic take: delete returns the number of keys removed (1 only for the first caller).
    const removed = await kv.del(`kelly:nonce:${nonce}`);
    return removed === 1;
  }
  const now = Date.now();
  pruneLocalNonces(now);
  const exp = _localNonces.get(nonce);
  if (exp === undefined || exp <= now) return false;
  _localNonces.delete(nonce);
  return true;
}

/* ------------------------------ verify + mint ---------------------------- */

let _verifyClient: SuiGrpcClient | null = null;
function verifyClient(): SuiGrpcClient {
  if (_verifyClient) return _verifyClient;
  const baseUrl = process.env.NEXT_PUBLIC_SUI_GRPC_URL || predictV2Config.grpcUrl;
  _verifyClient = new SuiGrpcClient({ network: walrusConfig.network, baseUrl });
  return _verifyClient;
}

export interface SignInProof extends SignInFields {
  /** The wallet's signature over buildSignInMessage(fields), base64 (wallet-standard). */
  signature: string;
}

/**
 * Verify a sign-in proof end to end: the issuedAt is fresh, the nonce is valid + unused,
 * and the signature over our rebuilt message recovers `address`. Returns the proven
 * lowercased address, or null on any failure. A client is passed so zkLogin (Google)
 * signatures verify too; only an environmental lookup (not a bad signature) throws.
 */
export async function verifySignIn(proof: SignInProof): Promise<string | null> {
  const address = (proof.address ?? '').trim().toLowerCase();
  if (!isValidSuiAddress(address)) return null;

  // Freshness — reject a stale (or future-dated) proof before doing any crypto.
  const issued = Date.parse(proof.issuedAt);
  if (!Number.isFinite(issued)) return null;
  const age = Date.now() - issued;
  if (age > MEMORY_SIGNIN_TTL_MS || age < -CLOCK_SKEW_MS) return null;

  // One-time nonce — consume it up front so a replay can't even reach the verify call.
  if (!(await consumeNonce(proof.nonce))) return null;

  const message = new TextEncoder().encode(
    buildSignInMessage({ address, nonce: proof.nonce, issuedAt: proof.issuedAt }),
  );
  try {
    const publicKey = await verifyPersonalMessageSignature(message, proof.signature, {
      client: verifyClient(),
      address,
    });
    // Belt and suspenders: the recovered key must map to the claimed address.
    return publicKey.toSuiAddress().toLowerCase() === address ? address : null;
  } catch {
    // Environmental failure (e.g. a zkLogin epoch/JWK lookup blip) — treat as not verified.
    return null;
  }
}

/** Mint a signed session token (JWT) for a proven address. */
export async function mintSession(address: string): Promise<string | null> {
  const key = secretKey();
  if (!key) return null;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(address.toLowerCase())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .sign(key);
}

/** Read + verify a session cookie value, returning the signed-in address or null. */
export async function readSession(token: string | undefined | null): Promise<string | null> {
  const key = secretKey();
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key);
    const sub = typeof payload.sub === 'string' ? payload.sub.toLowerCase() : '';
    return isValidSuiAddress(sub) ? sub : null;
  } catch {
    return null;
  }
}

/** Cookie options shared by set + clear (Secure only in production, so localhost works). */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_S,
  };
}
