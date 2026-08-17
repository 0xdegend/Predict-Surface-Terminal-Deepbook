/**
 * lib/walrus/memory.ts — Kelly's durable, encrypted memory on Walrus Memory (MemWal).
 *
 * Phase 1 (2026-08-15), proven on testnet: remember a fact, then recall it by a different
 * semantic query and get it back decrypted. The managed relayer embeds, Seal-encrypts,
 * uploads to Walrus, and indexes; the SDK just signs each request with our registered
 * delegate key. So this module is SERVER-ONLY (it reads the delegate key + account id from
 * the environment) — never import it into client bundles.
 *
 * Model: ONE app MemWalAccount (owner = the founder wallet; object id in
 * WALRUS_MEMORY_ACCOUNT_ID), with a NAMESPACE per trader so memories never mix between
 * wallets. Content is encrypted, so only the account owner and its authorized delegates can
 * decrypt. See config/walrus.ts and [[walrus-phase0]].
 *
 * Env required: WALRUS_DELEGATE_KEY (registered delegate private key hex) and
 * WALRUS_MEMORY_ACCOUNT_ID (the MemWalAccount object id).
 */
import { MemWal } from '@mysten-incubation/memwal';
import { walrusConfig } from '@/config/walrus';

/**
 * Namespace prefix for all Kelly memories (isolates them from any other app surface).
 * Bumped to `.v2` on 2026-08-17 to abandon leftover Phase-1 verification writes (a
 * "Per-user ns proof …" test entry + a seeded demo note) that were surfacing in recall.
 * MemWal exposes no delete, so a namespace bump is the clean reset; safe pre-launch (no
 * real trader memories yet). Raise the suffix again if we ever need another clean slate.
 */
const KELLY_NS = 'kelly.v2';

/** Each trader gets their own namespace within the shared account, so memories never mix. */
export function namespaceForUser(owner: string): string {
  return `${KELLY_NS}:${owner.toLowerCase()}`;
}

let _client: MemWal | null = null;

/** The MemWal client, signed by our registered delegate key. Server-only. */
export function getKellyMemory(): MemWal {
  if (_client) return _client;
  const key = process.env.WALRUS_DELEGATE_KEY;
  const accountId = process.env.WALRUS_MEMORY_ACCOUNT_ID;
  if (!key || !accountId) {
    throw new Error(
      'WALRUS_DELEGATE_KEY and WALRUS_MEMORY_ACCOUNT_ID must be set for Kelly memory (see config/walrus.ts).',
    );
  }
  _client = MemWal.create({
    key,
    accountId,
    serverUrl: walrusConfig.memoryRelayerUrl,
    namespace: KELLY_NS,
  });
  return _client;
}

export interface RememberedMemory {
  /** Stable id (also the vector row id). */
  id: string;
  /** Walrus blob id holding the encrypted memory. */
  blobId: string;
}

/**
 * Store a memory for a trader and wait until it is indexed. Namespaced per wallet.
 * `text` should be a short, self-contained fact, e.g. "prefers safer UP bets near the money".
 */
export async function rememberForUser(owner: string, text: string): Promise<RememberedMemory> {
  const r = await getKellyMemory().rememberAndWait(text, namespaceForUser(owner), {
    timeoutMs: 150_000,
  });
  return { id: r.id, blobId: r.blob_id };
}

export interface RecalledMemory {
  text: string;
}

/**
 * Recall a trader's most relevant memories for a query (semantic search over their
 * namespace). Returns decrypted text, most relevant first.
 */
export async function recallForUser(
  owner: string,
  query: string,
  limit = 5,
): Promise<RecalledMemory[]> {
  const res = await getKellyMemory().recall({
    query,
    namespace: namespaceForUser(owner),
    limit,
  });
  return (res.results ?? []).map((m) => ({ text: m.text ?? '' }));
}
