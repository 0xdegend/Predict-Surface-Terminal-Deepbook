/**
 * lib/walrus/receipts.ts — Verifiable Call Receipts (Kelly × Walrus, phase A1).
 *
 * Every time Kelly makes a falsifiable market CALL (a directional or range prediction on a
 * market with a known expiry), we mint a signed, timestamped receipt and store it durably on
 * Walrus. The receipt is:
 *   - IMMUTABLE + CONTENT-ADDRESSED — Walrus returns a blobId that is the hash of the bytes, so
 *     anyone can fetch it from the public aggregator and know it was never altered.
 *   - AUTHORED BY KELLY — the receipt carries an Ed25519 signature over its canonical bytes,
 *     made with our server writer key, plus that key's public key + address. Anyone can verify
 *     the call really came from us (readCallReceipt does exactly this on the way back in).
 *   - SCOREABLE — the claim records the strike/band, the fair probability Kelly quoted, spot +
 *     forward at call time, and the market id + expiry, so the call can later be marked
 *     won/lost against the market's settlement (scoreCall / trackRecord).
 *
 * This turns "Kelly remembers you" into "Kelly has a track record you can check." Builds on the
 * Phase 0 blob layer ([[walrus-phase0]], lib/walrus/client.ts). SERVER-ONLY — it signs with the
 * writer key. The verify + score helpers are pure and safe anywhere.
 */
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import { storeJson, readBlobJson, getWriterKeypair } from '@/lib/walrus/client';
import { walrusConfig } from '@/config/walrus';
import { kv } from '@/lib/server/kv';

/* --------------------------------- schema -------------------------------- */

export type CallKind = 'binary' | 'range';
export type CallSource = 'rules' | 'ai';
export type CallOutcome = 'won' | 'lost' | 'pending';

/** The falsifiable claim: what Kelly predicted and how it gets scored. Prices are in USD. */
export interface CallClaim {
  kind: CallKind;
  asset: 'BTC';
  /** binary only — the side that pays (up = settles above strike). */
  direction?: 'up' | 'down';
  /** binary only — the strike, in USD. */
  strike?: number;
  /** range only — the band, in USD. Pays if settlement lands in (lower, higher]. */
  lower?: number;
  higher?: number;
  /** Kelly's fair probability the call resolves true (0..1). */
  probability: number;
  /** BTC spot at the moment of the call (USD). */
  spotAtCall: number;
  /** Market forward at call time (USD). */
  forward: number;
  /** Market settle time (ms epoch) — the call is scored at/after this. */
  expiry: number;
  /** The market this call is on (expiry_market_id), so settlement can be resolved later. */
  marketId: string;
}

/**
 * The structural "what the call is about" — the ONLY thing the client sends. The server
 * recomputes the trustworthy fields (probability, spot, forward) from the LIVE pricer before
 * minting, so a caller can't forge Kelly's odds. See app/api/kelly/receipts/route.ts.
 */
export interface CallIntent {
  kind: CallKind;
  marketId: string;
  /** Market settle time (ms) — a client hint used only to gate WHEN a call is resolved;
   *  scoring is strike/band vs settlement, so a wrong value never changes won/lost. */
  expiry: number;
  source: CallSource;
  /** binary */
  direction?: 'up' | 'down';
  strike?: number;
  /** range */
  lower?: number;
  higher?: number;
}

/** The fields the server computes from the live pricer (never trusted from the client). */
export interface PricedFields {
  probability: number;
  spotAtCall: number;
  forward: number;
}

/**
 * Assemble a full, scoreable claim from a validated client intent + the server-computed
 * priced fields. The route validates the intent's structural fields before calling this.
 */
export function claimFromIntent(intent: CallIntent, priced: PricedFields): CallClaim {
  const base = {
    asset: 'BTC' as const,
    probability: priced.probability,
    spotAtCall: priced.spotAtCall,
    forward: priced.forward,
    expiry: intent.expiry,
    marketId: intent.marketId,
  };
  return intent.kind === 'range'
    ? { ...base, kind: 'range', lower: intent.lower, higher: intent.higher }
    : { ...base, kind: 'binary', direction: intent.direction, strike: intent.strike };
}

/** The signable core of a receipt (everything the signature covers). */
export interface CallReceiptCore {
  version: 1;
  author: 'kelly';
  source: CallSource;
  /** ms epoch when Kelly made the call. */
  createdAt: number;
  id: string;
  claim: CallClaim;
}

/** A full receipt: the signed core plus the authorship proof stored alongside it on Walrus. */
export interface CallReceipt extends CallReceiptCore {
  /** Base64 Ed25519 signature over canonicalBytes(core). */
  signature: string;
  /** Base64 writer public key — verify the signature against this. */
  publicKey: string;
  /** Writer Sui address (convenience; must equal publicKey.toSuiAddress()). */
  signerAddress: string;
}

/** A compact index row, kept in KV so receipts are listable + scoreable without a blob fetch. */
export interface ReceiptIndexEntry {
  id: string;
  blobId: string;
  createdAt: number;
  source: CallSource;
  claim: CallClaim;
}

/* ------------------------- canonical bytes + signing --------------------- */

/**
 * Deterministic JSON with recursively sorted keys, so the bytes we sign match the bytes a
 * verifier reconstructs regardless of field order. Numbers/strings/bools/null/arrays/objects
 * only (receipts contain nothing else).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** The exact bytes the signature covers. */
export function canonicalBytes(core: CallReceiptCore): Uint8Array {
  return new TextEncoder().encode(stableStringify(core));
}

/* --------------------------------- index --------------------------------- */

const INDEX_KEY = 'kelly:receipts:index';
const MAX_INDEX = 1000;
const _localIndex: ReceiptIndexEntry[] = [];

async function pushIndex(entry: ReceiptIndexEntry): Promise<void> {
  if (kv) {
    await kv.lpush(INDEX_KEY, JSON.stringify(entry));
    await kv.ltrim(INDEX_KEY, 0, MAX_INDEX - 1);
  } else {
    _localIndex.unshift(entry);
    if (_localIndex.length > MAX_INDEX) _localIndex.length = MAX_INDEX;
  }
}

/** Read the most recent index rows (newest first). */
export async function listCallReceipts(limit = 50): Promise<ReceiptIndexEntry[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_INDEX);
  if (kv) {
    const rows = await kv.lrange(INDEX_KEY, 0, n - 1);
    return rows
      .map((r) => {
        try {
          return (typeof r === 'string' ? JSON.parse(r) : r) as ReceiptIndexEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ReceiptIndexEntry => !!e && !!e.blobId && !!e.claim);
  }
  return _localIndex.slice(0, n);
}

/** Test-only: clear the in-process index (no effect when KV is configured). */
export function _resetReceiptIndex(): void {
  _localIndex.length = 0;
}

/* ---------------------------------- mint --------------------------------- */

function randomId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex');
}

export interface MintCallInput {
  claim: CallClaim;
  source: CallSource;
  /** Override the call timestamp (defaults to now). */
  createdAt?: number;
}

/**
 * Mint a receipt for a call: build the core, sign it with the writer key, store it on Walrus,
 * and index it. Returns the id + content-addressed blobId (share/verify with the blobId).
 * Server-only (signs with the writer key). Throws if the writer key isn't configured.
 */
export async function mintCallReceipt(input: MintCallInput): Promise<{ id: string; blobId: string }> {
  const keypair = getWriterKeypair();
  const core: CallReceiptCore = {
    version: 1,
    author: 'kelly',
    source: input.source,
    createdAt: input.createdAt ?? Date.now(),
    id: randomId(),
    claim: input.claim,
  };
  const signature = toBase64(await keypair.sign(canonicalBytes(core)));
  const receipt: CallReceipt = {
    ...core,
    signature,
    publicKey: keypair.getPublicKey().toBase64(),
    signerAddress: keypair.toSuiAddress(),
  };
  const { blobId } = await storeJson(receipt, { epochs: walrusConfig.defaultEpochs, deletable: false });
  await pushIndex({ id: core.id, blobId, createdAt: core.createdAt, source: core.source, claim: core.claim });
  return { id: core.id, blobId };
}

/* --------------------------------- verify -------------------------------- */

export interface VerifiedReceipt {
  receipt: CallReceipt;
  /** True when the signature checks out against the embedded public key + address. */
  verified: boolean;
}

/** Recompute the core (drop the proof wrapper) from a full receipt. */
function coreOf(r: CallReceipt): CallReceiptCore {
  return { version: r.version, author: r.author, source: r.source, createdAt: r.createdAt, id: r.id, claim: r.claim };
}

/** Verify a receipt's authorship signature (pure, offline). */
export async function verifyReceiptSignature(r: CallReceipt): Promise<boolean> {
  try {
    const pub = new Ed25519PublicKey(fromBase64(r.publicKey));
    if (pub.toSuiAddress() !== r.signerAddress) return false;
    return await pub.verify(canonicalBytes(coreOf(r)), fromBase64(r.signature));
  } catch {
    return false;
  }
}

/**
 * Fetch a receipt by blobId from the public Walrus aggregator and verify its signature.
 * The blobId already guarantees the bytes are unaltered; the signature proves Kelly authored
 * them. Safe to call from anywhere (read path is public, no key needed).
 */
export async function readCallReceipt(blobId: string): Promise<VerifiedReceipt> {
  const receipt = await readBlobJson<CallReceipt>(blobId);
  const verified = await verifyReceiptSignature(receipt);
  return { receipt, verified };
}

/* --------------------------------- score --------------------------------- */

/**
 * Score a call against a settlement price (USD). Returns 'pending' when there's no settlement
 * yet (unresolved). Range pays if settlement lands in (lower, higher]; up pays above strike.
 */
export function scoreCall(claim: CallClaim, settlementPrice: number | null | undefined): CallOutcome {
  if (settlementPrice == null || !Number.isFinite(settlementPrice)) return 'pending';
  if (claim.kind === 'range') {
    const inBand = settlementPrice > (claim.lower ?? 0) && settlementPrice <= (claim.higher ?? 0);
    return inBand ? 'won' : 'lost';
  }
  const above = settlementPrice > (claim.strike ?? 0);
  const won = claim.direction === 'up' ? above : !above;
  return won ? 'won' : 'lost';
}

export interface ScoredCall extends ReceiptIndexEntry {
  outcome: CallOutcome;
}

export interface TrackRecord {
  total: number;
  resolved: number;
  won: number;
  lost: number;
  pending: number;
  /** Win rate over RESOLVED calls only (0..1), or null when nothing has resolved. */
  winRate: number | null;
  calls: ScoredCall[];
}

/**
 * Aggregate a track record from index rows, scoring each against a settlement resolver
 * (marketId → settlement price in USD, or null when not settled yet). Pure: the caller owns
 * how settlement is sourced, so this stays testable and the on-chain read lives at the edge.
 */
export function trackRecord(
  entries: ReceiptIndexEntry[],
  resolveSettlement: (marketId: string) => number | null,
): TrackRecord {
  const calls: ScoredCall[] = entries.map((e) => ({
    ...e,
    outcome: scoreCall(e.claim, resolveSettlement(e.claim.marketId)),
  }));
  const won = calls.filter((c) => c.outcome === 'won').length;
  const lost = calls.filter((c) => c.outcome === 'lost').length;
  const pending = calls.filter((c) => c.outcome === 'pending').length;
  const resolved = won + lost;
  return {
    total: calls.length,
    resolved,
    won,
    lost,
    pending,
    winRate: resolved > 0 ? won / resolved : null,
    calls,
  };
}

/* ------------------------------- summarize ------------------------------- */

// The display formatters live in the dependency-free receipt-format module (so the OG image /
// per-call page can use them without pulling the Walrus write SDK). Re-exported here so existing
// server callers keep importing them from '@/lib/walrus/receipts'.
export { summarizeClaim, claimHeadline, receiptBlobUrl, fetchCallReceipt } from './receipt-format';
