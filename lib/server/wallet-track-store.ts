/**
 * lib/server/wallet-track-store.ts — SERVER-ONLY store of how each wallet signed in.
 *
 * Powers the admin "Wallet mix" card (Google vs Slush vs Other, over a time window).
 * One Redis SORTED SET per kind, member = wallet address, score = FIRST-seen ms. A
 * wallet lives in exactly one set (its latest sign-in method); the score is its first
 * connect, so a time window (last 1d / 7d / 14d / all) is a `ZRANGE ... BYSCORE`. Reuses
 * the shared KV client; falls back to an in-process map when no Redis is configured
 * (local dev / a fork), same pattern as [[grant-store]]. Records only the public
 * address + the sign-in CATEGORY + first-seen time — never a Google identity or PII.
 */
import { kv } from './kv';
import { WALLET_KINDS, type WalletKind } from '@/lib/wallet-kind';

const zKey = (k: WalletKind) => `walletmix:z:${k}`;

// In-process fallback (per instance): kind → (address → firstSeenMs).
const mem: Record<WalletKind, Map<string, number>> = {
  google: new Map(),
  slush: new Map(),
  other: new Map(),
};

/** Record a wallet under its sign-in kind at `nowMs`, removing it from the others so a
 *  wallet is counted once (latest method wins). First-seen time is PRESERVED on repeat
 *  connects (add-if-absent), so a window always reflects when the wallet first arrived.
 *  Idempotent — safe to call every connect. */
export async function recordWalletKind(
  address: string,
  kind: WalletKind,
  nowMs: number = Date.now(),
): Promise<void> {
  const addr = address.toLowerCase();
  const others = WALLET_KINDS.filter((k) => k !== kind);
  const client = kv;
  if (client) {
    await Promise.all([
      // NX keeps the original first-seen score if the wallet is already in this set.
      client.zadd(zKey(kind), { nx: true }, { score: nowMs, member: addr }),
      ...others.map((k) => client.zrem(zKey(k), addr)),
    ]);
    return;
  }
  for (const k of others) mem[k].delete(addr);
  if (!mem[kind].has(addr)) mem[kind].set(addr, nowMs);
}

export type WalletMixMembers = Record<WalletKind, string[]>;

/**
 * Addresses per kind first-seen at/after `sinceMs` (lowercased). `sinceMs = 0` is
 * all-time. Drives the windowed admin summary.
 */
export async function listWalletMixSince(sinceMs: number): Promise<WalletMixMembers> {
  const client = kv;
  if (client) {
    const [google, slush, other] = await Promise.all(
      WALLET_KINDS.map(
        (k) =>
          client.zrange(zKey(k), sinceMs, Number.MAX_SAFE_INTEGER, { byScore: true }) as Promise<string[]>,
      ),
    );
    return { google, slush, other };
  }
  const pick = (k: WalletKind) =>
    [...mem[k].entries()].filter(([, ts]) => ts >= sinceMs).map(([a]) => a);
  return { google: pick('google'), slush: pick('slush'), other: pick('other') };
}
