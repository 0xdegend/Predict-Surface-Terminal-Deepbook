/**
 * lib/sui/v2/session.ts — delegated trading sessions (Phase 0 + 1).
 *
 * A session is an EPHEMERAL Secp256r1 keypair generated in the browser via the
 * WebCrypto signer, whose private key is NON-EXTRACTABLE (no script/extension can
 * exfiltrate it). The account owner authorizes that key ONCE with a single Slush
 * signature (`sessions::authorize_session`), after which the key can call the
 * Predict trade wrappers directly — no wallet popup per trade. See the
 * sessions-delegated-trading note and https://github.com/MystenLabs/deepbookv3/tree/main/packages/sessions.
 *
 * The session can ONLY trade the DUSDC deposited into the wrapper; it cannot
 * withdraw, cannot touch the main wallet, and cannot authorize/revoke (owner-only).
 * It is bounded by an on-chain expiry (≤30 days) and revocable in one tap.
 *
 * This module owns: the key lifecycle (generate / persist / restore / clear), the
 * on-chain expiry read, and the authorize/revoke PTB builders. Trading through the
 * session (routing mints/redeems to `sessions::*`) lands in Phase 2.
 */
import { WebCryptoSigner, type ExportedWebCryptoKeypair } from '@mysten/webcrypto-signer';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config, v2SessionTarget } from '@/config/predict';
import { addDeposit, simulate, SIM_SENDER, type SimulateCapableClient } from './account';
import { addSetBuilderCode } from './builder-code';

/** `${sessions_pkg}::sessions::<fn>` (the module inside is `sessions`). */
const SESS = (fn: string) => v2SessionTarget('sessions', fn);

/**
 * The stored session. `keypair` holds a live, non-extractable `CryptoKey` — it is
 * ONLY structured-clone-safe (IndexedDB), never JSON: `JSON.stringify` on it throws.
 */
export interface StoredSession {
  keypair: ExportedWebCryptoKeypair;
  address: string;
  createdAt: number;
}

/* ------------------------------- storage --------------------------------- */
/* IndexedDB in the browser; an in-memory map covers SSR/tests (no durable session
 * is expected there — the whole flow is client-driven). */

const DB_NAME = 'skew-sessions';
const STORE = 'keys';
const memStore = new Map<string, StoredSession>();
const hasIDB = (): boolean => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function storeGet(key: string): Promise<StoredSession | undefined> {
  if (!hasIDB()) return memStore.get(key);
  return idbDo<StoredSession | undefined>('readonly', (s) => s.get(key));
}
async function storeSet(key: string, val: StoredSession): Promise<void> {
  if (!hasIDB()) {
    memStore.set(key, val);
    return;
  }
  await idbDo('readwrite', (s) => s.put(val, key));
}
async function storeDel(key: string): Promise<void> {
  if (!hasIDB()) {
    memStore.delete(key);
    return;
  }
  await idbDo('readwrite', (s) => s.delete(key));
}

/** Storage key: owner + deployment scoped, so a wallet switch or a redeploy always
 *  uses a fresh session (never a stale key against the wrong account/package). */
export function sessionStorageKey(owner: string): string {
  return `${owner.toLowerCase()}::${predictV2Config.packages.predict}`;
}

/* ---------------------------- key lifecycle ------------------------------ */

/** A fresh non-extractable session keypair (generated with the WebCrypto API). */
export function generateSession(): Promise<WebCryptoSigner> {
  return WebCryptoSigner.generate({ extractable: false });
}

/** The session key's Sui address (the address the owner authorizes to trade). */
export function sessionAddressOf(signer: WebCryptoSigner): string {
  return signer.getPublicKey().toSuiAddress();
}

/** Persist a session for `owner`, returning what was stored. */
export async function saveSession(owner: string, signer: WebCryptoSigner): Promise<StoredSession> {
  const stored: StoredSession = {
    keypair: signer.export(),
    address: sessionAddressOf(signer),
    createdAt: Date.now(),
  };
  await storeSet(sessionStorageKey(owner), stored);
  return stored;
}

export interface LoadedSession {
  signer: WebCryptoSigner;
  address: string;
  createdAt: number;
}

/** Restore `owner`'s persisted session (null if none). The private key comes back as
 *  a usable non-extractable CryptoKey (structured clone preserves it). */
export async function loadSession(owner: string): Promise<LoadedSession | null> {
  const stored = await storeGet(sessionStorageKey(owner));
  if (!stored) return null;
  const signer = await WebCryptoSigner.import(stored.keypair);
  return { signer, address: stored.address, createdAt: stored.createdAt };
}

/** Forget `owner`'s local session key (pair with an on-chain `revoke_session`). */
export async function clearSession(owner: string): Promise<void> {
  await storeDel(sessionStorageKey(owner));
}

/* ----------------------------- on-chain read ----------------------------- */

/**
 * The session's on-chain expiry (ms), or null if it is not authorized on this
 * wrapper. This is the source of truth for "is the session live" — the local key
 * existing does NOT mean it is still authorized (it may have expired or been revoked).
 */
export async function readSessionExpiry(
  client: SimulateCapableClient,
  wrapperId: string,
  sessionAddress: string,
): Promise<number | null> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  tx.moveCall({
    target: SESS('session_expiration_ms'),
    arguments: [tx.object(wrapperId), tx.pure.address(sessionAddress)],
  });
  const res = await simulate(client, tx);
  const last = res.commandResults?.at(-1);
  if (!last?.returnValues?.length) return null;
  const opt = bcs.option(bcs.u64()).parse(new Uint8Array(last.returnValues[0].bcs));
  return opt == null ? null : Number(opt);
}

/** Live = authorized and not past expiry. */
export function isSessionLive(expiryMs: number | null, now: number = Date.now()): boolean {
  return expiryMs != null && expiryMs > now;
}

/* ------------------------------- builders -------------------------------- */

/** The protocol caps a session at 30 days; we offer the user a short menu. Default 24h. */
export const SESSION_DURATIONS_MS = {
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
} as const;
export type SessionDuration = keyof typeof SESSION_DURATIONS_MS;
export const DEFAULT_SESSION_DURATION: SessionDuration = '24h';

/** Default SUI (MIST) to fund a fresh session key with at authorize time so it can
 *  pay its own gas — sessions are Slush-only, and the key holds no SUI otherwise.
 *  ~0.1 SUI covers many testnet trades; the UI can top the key up if it runs low. */
export const DEFAULT_SESSION_GAS_FUNDING_BASE = 100_000_000n;

/**
 * Fixed gas budget (MIST) for a session trade. Setting it explicitly is the point of
 * the Phase 3 fast path: it lets the submit skip the SDK's dry-run gas estimation. ~0.03
 * SUI comfortably covers a mint (load_pricer + mint). The budget is a reservation cap,
 * so the key's balance must be at least this much — when it falls below, re-enable the
 * session to top the gas back up (auto top-up is a later phase). Must stay well under
 * DEFAULT_SESSION_GAS_FUNDING_BASE so a freshly funded key gets several trades.
 */
export const SESSION_GAS_BUDGET = 30_000_000n;

export interface AuthorizeSessionParams {
  wrapperId: string;
  sessionAddress: string;
  durationMs: number;
  /** DUSDC base units to deposit into the wrapper for the session to trade with (owner
   *  funds; the session can only ever spend this). Omit/0 to authorize without funding. */
  depositBase?: bigint;
  /** SUI base units to send to the session key so it can pay gas (Slush path). Gasless
   *  (Enoki) users sponsor the session's txs instead, so leave this unset there. */
  gasFundingBase?: bigint;
  /** Attribute this account to our BuilderCode in the same owner-signed PTB. Session
   *  trades can't attach it themselves (owner-gated), so we ride it along here so the
   *  fee rail is wired for every session trade. Only pass true when the slot is EMPTY
   *  (see `shouldAttach` in use-builder-code) — no-op if we have no code on this net. */
  attachBuilderCode?: boolean;
}

/**
 * One owner-signed PTB (the single Slush popup) that optionally deposits a session
 * budget into the wrapper, attributes the account to our builder code, authorizes the
 * session key, and optionally funds the key a little SUI for gas. The deposit, attach
 * and authorize are all gated on the OWNER being the sender, so this must be signed by
 * the connected wallet, never the session key.
 */
export interface AddAuthorizeSessionParams {
  wrapperId: string;
  sessionAddress: string;
  durationMs: number;
  /** SUI base units to send the session key for gas (Slush path). Omit/0 to skip. */
  gasFundingBase?: bigint;
}

/**
 * Append `authorize_session` (+ an optional SUI gas top-up to the session key) to an
 * EXISTING owner-signed tx. Both are owner-gated, so the tx must be signed by the
 * connected wallet. Used two ways: standalone (buildAuthorizeSessionTx) and bundled
 * into a first trade's mint PTB, so turning instant trading on costs no extra pop-up.
 */
export function addAuthorizeSession(tx: Transaction, p: AddAuthorizeSessionParams): void {
  tx.moveCall({
    target: SESS('authorize_session'),
    arguments: [
      tx.object(p.wrapperId),
      tx.pure.address(p.sessionAddress),
      tx.pure.u64(p.durationMs),
      tx.object(predictV2Config.clockId),
    ],
  });
  if (p.gasFundingBase && p.gasFundingBase > 0n) {
    const sui = tx.add(coinWithBalance({ balance: p.gasFundingBase })); // native SUI from the gas coin
    tx.transferObjects([sui], tx.pure.address(p.sessionAddress));
  }
}

export function buildAuthorizeSessionTx(p: AuthorizeSessionParams): Transaction {
  const tx = new Transaction();
  if (p.depositBase && p.depositBase > 0n) addDeposit(tx, p.wrapperId, p.depositBase);
  if (p.attachBuilderCode) addSetBuilderCode(tx, p.wrapperId);
  addAuthorizeSession(tx, {
    wrapperId: p.wrapperId,
    sessionAddress: p.sessionAddress,
    durationMs: p.durationMs,
    gasFundingBase: p.gasFundingBase,
  });
  return tx;
}

/** Owner-signed revoke — immediately frees the slot and kills the session's access. */
export function buildRevokeSessionTx(wrapperId: string, sessionAddress: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: SESS('revoke_session'),
    arguments: [tx.object(wrapperId), tx.pure.address(sessionAddress)],
  });
  return tx;
}

/* --------------------------- session gas sweep --------------------------- */

export const SUI_TYPE = '0x2::sui::SUI';
/** Below this, the sweep tx's own gas is worth more than what it returns — skip it
 *  (and it may not even cover its own gas). ~0.01 SUI. */
export const SESSION_SWEEP_DUST_MIST = 10_000_000n;

/**
 * SESSION-signed sweep of the key's leftover gas SUI back to the owner. Transferring
 * `tx.gas` sends the gas coin's remainder (after this tx's own gas) to `owner` — the
 * standard "send all my SUI" idiom. Signed by the SESSION key, which can still sign a
 * plain transfer even after its trading authorization expired (only the `sessions::*`
 * trade calls are gated). Pair with revoke + clear on `endSession` so the funded gas
 * is never stranded at a key we're about to discard.
 */
export function buildSweepSessionGasTx(owner: string): Transaction {
  const tx = new Transaction();
  tx.transferObjects([tx.gas], tx.pure.address(owner));
  return tx;
}
