/**
 * lib/server/reward-store.ts — SERVER-ONLY claim ledger for the traders reward.
 *
 * One claim per eligible wallet per campaign, enforced durably. Mirrors [[grant-store]]:
 *   reward:<campaign>:done:<addr>  permanent marker = the payout tx digest (set ONLY
 *                                  after the transfer confirms on-chain)
 *   reward:<campaign>:lock:<addr>  short-lived in-flight lock (NX+TTL) — kills the
 *                                  double-pay race the done-check alone can't
 * Reuses the shared KV client; in-process fallback when no Redis (local dev / a fork).
 * The `campaign` namespaces every key, so a future campaign is a clean slate.
 */
import { kv } from './kv';

const DONE_TTL = 60 * 60 * 24 * 365; // a year — effectively permanent for the campaign
const LOCK_TTL = 120; // seconds — long enough to cover a payout + confirmation

const doneKey = (campaign: string, addr: string) => `reward:${campaign}:done:${addr.toLowerCase()}`;
const lockKey = (campaign: string, addr: string) => `reward:${campaign}:lock:${addr.toLowerCase()}`;

// In-process fallback (per instance).
const memDone = new Map<string, string>();
const memLock = new Map<string, number>();

/** The stored payout digest for a wallet, or null if never paid. */
export async function getRewardClaim(campaign: string, address: string): Promise<string | null> {
  const k = doneKey(campaign, address);
  if (kv) return (await kv.get<string>(k)) ?? null;
  return memDone.get(k) ?? null;
}

/** A real payout marker is a tx digest (not a legacy '1' sentinel), so it truly paid. */
export function isRealRewardPayout(v: string | null | undefined): boolean {
  return !!v && v !== '1' && v.length > 6;
}

export async function hasRewardClaim(campaign: string, address: string): Promise<boolean> {
  return isRealRewardPayout(await getRewardClaim(campaign, address));
}

/** Persist the claim (payout digest). Called ONLY after the transfer confirms. */
export async function markRewardClaimed(campaign: string, address: string, digest: string): Promise<void> {
  const k = doneKey(campaign, address);
  if (kv) await kv.set(k, digest, { ex: DONE_TTL });
  else memDone.set(k, digest);
}

/** Take the per-address in-flight lock; false if another claim is mid-flight. */
export async function acquireRewardLock(campaign: string, address: string): Promise<boolean> {
  const k = lockKey(campaign, address);
  if (kv) return (await kv.set(k, '1', { nx: true, ex: LOCK_TTL })) === 'OK';
  const now = Date.now();
  const until = memLock.get(k) ?? 0;
  if (until > now) return false;
  memLock.set(k, now + LOCK_TTL * 1000);
  return true;
}

export async function releaseRewardLock(campaign: string, address: string): Promise<void> {
  const k = lockKey(campaign, address);
  if (kv) await kv.del(k);
  else memLock.delete(k);
}

/** All wallets that have claimed this campaign (lowercased) — for admin progress. Cursor
 *  SCAN so a big campaign doesn't block; bounded per iteration. */
export async function listRewardClaimers(campaign: string): Promise<string[]> {
  const prefix = `reward:${campaign}:done:`;
  if (!kv) return [...memDone.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = (await kv.scan(cursor, { match: `${prefix}*`, count: 200 })) as [string, string[]];
    cursor = next;
    for (const k of keys) out.push(k.slice(prefix.length));
  } while (cursor !== '0');
  return out;
}
