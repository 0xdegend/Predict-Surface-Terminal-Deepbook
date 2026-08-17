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
import { isMeaningfulMemory } from '@/lib/copilot/memory-quality';

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
  /** The relayer's job id (also the vector row id once indexed). Known immediately. */
  id: string;
  /** The relayer's accept status, e.g. "pending". */
  status: string;
}

/**
 * Store a memory for a trader and return as soon as the relayer ACCEPTS the job (a
 * fast 202), so Kelly can acknowledge instantly. The relayer keeps embedding,
 * Seal-encrypting, uploading to Walrus, and indexing in the BACKGROUND — that
 * pipeline is the ~10-30s the old `rememberAndWait` used to block the reply on.
 * Namespaced per wallet.
 *
 * The write is optimistic: the caller should acknowledge, then run
 * `confirmRememberForUser(id, owner)` after the response (via `after()`) to catch a
 * genuine failure. `text` should be a short, self-contained fact, e.g.
 * "prefers safer UP bets near the money".
 */
export async function rememberForUser(owner: string, text: string): Promise<RememberedMemory> {
  const r = await getKellyMemory().remember(text, namespaceForUser(owner));
  return { id: r.job_id, status: r.status };
}

/**
 * Best-effort confirmation of an accepted remember job: poll it to its terminal
 * state and log (never throw) if it failed or timed out. Meant to run AFTER the
 * response has gone out (via Next's `after()`), so the trader's ack stays instant
 * and an optimistic "saved" never silently swallows a real failure. A memory that
 * didn't stick just won't turn up in recall.
 */
export async function confirmRememberForUser(jobId: string, owner: string): Promise<void> {
  try {
    await getKellyMemory().waitForRememberJob(jobId, { timeoutMs: 150_000 });
  } catch (err) {
    console.error(`[kelly-memory] remember job ${jobId} for ${owner} did not confirm:`, err);
  }
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
  // Drop any filler fragment ("from now", "for later") a pre-guard write left behind, so
  // leftover junk never renders in the greeting or the "what do you remember" list. There's
  // no per-item delete on Walrus Memory, so hiding it at recall is how we retire one.
  return (res.results ?? [])
    .map((m) => ({ text: m.text ?? '' }))
    .filter((m) => isMeaningfulMemory(m.text));
}
