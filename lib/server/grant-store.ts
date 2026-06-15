/**
 * lib/server/grant-store.ts — durable ledger for the starter grant (server-only).
 *
 * The /api/starter-grant route must remember who it already funded ACROSS
 * redeploys and ACROSS Vercel's multiple serverless instances — an in-process
 * Set forgets on restart and isn't shared between instances, so a user could
 * re-claim after a deploy or by hitting a different instance.
 *
 * Backed by Redis (Upstash — what "Vercel KV" provisions today; the marketplace
 * integration injects KV_REST_API_URL / KV_REST_API_TOKEN, which we read here).
 * When those env vars are absent (local dev, or a fork without a store) it falls
 * back to an in-process implementation so the route still works — just without
 * the cross-deploy / cross-instance guarantees. The route's balance gate remains
 * the hard anti-double-fund backstop either way.
 *
 * Three pieces of state, keyed per address / per UTC day:
 *   grant:done:<addr>  permanent "already funded" marker (set only after payout)
 *   grant:lock:<addr>  short-lived in-flight lock (NX + TTL) — kills the race
 *                      where two concurrent requests both pass the done-check
 *   grant:daily:<day>  shared daily payout counter (global spend circuit breaker)
 */
import { Redis } from '@upstash/redis';

const REST_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** True when a Redis store is configured (durable, cross-instance). */
export const grantStoreDurable = !!REST_URL && !!REST_TOKEN;

const redis = grantStoreDurable ? new Redis({ url: REST_URL!, token: REST_TOKEN! }) : null;

/** Seconds a permanent "done" marker lives. ~1yr — effectively permanent, but
 *  bounded so the store can't grow forever on testnet churn. */
const DONE_TTL = 60 * 60 * 24 * 365;
/** In-flight lock lifetime. If a request crashes mid-payout, the lock frees
 *  itself after this and the user can retry. */
const LOCK_TTL = 120;
/** Daily counter lifetime (a touch over 24h so the key self-expires). */
const DAY_TTL = 60 * 60 * 26;

const doneKey = (addr: string) => `grant:done:${addr}`;
const lockKey = (addr: string) => `grant:lock:${addr}`;
const utcDay = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const dayKey = () => `grant:daily:${utcDay()}`;

/* ---------------- in-process fallback (no Redis configured) ---------------- */

const memDone = new Set<string>();
const memLock = new Map<string, number>(); // addr -> expiry epoch ms
let memDay = '';
let memCount = 0;

function memRollDay() {
  const d = utcDay();
  if (d !== memDay) {
    memDay = d;
    memCount = 0;
  }
}

/* ------------------------------- public API ------------------------------- */

/** Has this address already been funded? (permanent marker) */
export async function hasGranted(address: string): Promise<boolean> {
  if (redis) return (await redis.exists(doneKey(address))) === 1;
  return memDone.has(address);
}

/** Try to take the in-flight lock. Returns false if another request holds it
 *  (concurrent claim) — the caller should refuse. Atomic via SET NX. */
export async function acquireLock(address: string): Promise<boolean> {
  if (redis) {
    const r = await redis.set(lockKey(address), '1', { nx: true, ex: LOCK_TTL });
    return r === 'OK';
  }
  const now = Date.now();
  const exp = memLock.get(address);
  if (exp && exp > now) return false;
  memLock.set(address, now + LOCK_TTL * 1000);
  return true;
}

/** Release the in-flight lock (always call in a finally). */
export async function releaseLock(address: string): Promise<void> {
  if (redis) {
    await redis.del(lockKey(address));
    return;
  }
  memLock.delete(address);
}

/** Persist the permanent "funded" marker. Call only after a successful payout
 *  (or when we decide a wallet never needs funding). */
export async function markGranted(address: string, digest = '1'): Promise<void> {
  if (redis) {
    await redis.set(doneKey(address), digest, { ex: DONE_TTL });
    return;
  }
  memDone.add(address);
}

/** Current number of grants paid today (UTC). */
export async function dailyCount(): Promise<number> {
  if (redis) return (await redis.get<number>(dayKey())) ?? 0;
  memRollDay();
  return memCount;
}

/** Increment today's grant counter (call after a successful payout). */
export async function bumpDaily(): Promise<void> {
  if (redis) {
    const n = await redis.incr(dayKey());
    if (n === 1) await redis.expire(dayKey(), DAY_TTL);
    return;
  }
  memRollDay();
  memCount += 1;
}
