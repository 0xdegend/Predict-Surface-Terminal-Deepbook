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

const memDone = new Map<string, string>(); // addr -> payout digest (or '1' sentinel)
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

/** The stored "funded" marker value, or null if none. A real payout stores its
 *  tx DIGEST; the old balance-gate stored the sentinel '1'. The route uses this
 *  to tell a genuine prior payout from a stale/false marker (self-healing). */
export async function getGranted(address: string): Promise<string | null> {
  if (redis) return (await redis.get<string | number>(doneKey(address)))?.toString() ?? null;
  return memDone.get(address) ?? null;
}

/** Remove a "funded" marker — used to heal a stale/false one so a genuinely
 *  never-funded wallet isn't blocked forever. */
export async function clearGranted(address: string): Promise<void> {
  if (redis) {
    await redis.del(doneKey(address));
    return;
  }
  memDone.delete(address);
}

/** True only when a marker is a GENUINE payout record: the executed transfer's
 *  tx digest (base58, 32-48 chars), written after the transfer confirmed. The old
 *  balance gate wrote the sentinel '1' WITHOUT paying, so that (and anything else
 *  that isn't a real digest) reads as a false marker the route heals rather than
 *  trusts — this is what stops a never-funded wallet being told "already funded". */
export function isRealPayoutMarker(value: string | null | undefined): boolean {
  return !!value && /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value);
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
  memDone.set(address, digest);
}

/**
 * Every wallet that has claimed the starter grant, lowercased. Enumerated from the
 * permanent `grant:done:*` markers via a cursor SCAN (bounded per iteration so it
 * never blocks the store), deduped. The markers are keyed by address only, so this
 * list already spans every deployment (6-24 / 7-29 / 8-06). Cached briefly in-process
 * because the leaderboard route asks for it on every request; falls back to the
 * in-process ledger when no Redis is configured (local dev). Never throws — a store
 * hiccup yields the last good list (or empty), so the board still renders.
 */
const CLAIMERS_TTL_MS = 5 * 60_000;
let claimersCache: { at: number; list: string[] } | null = null;

export async function listFaucetClaimers(): Promise<string[]> {
  if (claimersCache && Date.now() - claimersCache.at < CLAIMERS_TTL_MS) return claimersCache.list;
  const prefix = 'grant:done:';
  try {
    let list: string[];
    if (redis) {
      const seen = new Set<string>();
      let cursor = '0';
      let guard = 0;
      do {
        const [next, keys] = await redis.scan(cursor, { match: `${prefix}*`, count: 500 });
        for (const k of keys) seen.add(k.slice(prefix.length).toLowerCase());
        cursor = next;
      } while (cursor !== '0' && ++guard < 1000);
      list = [...seen];
    } else {
      list = [...memDone.keys()].map((a) => a.toLowerCase());
    }
    claimersCache = { at: Date.now(), list };
    return list;
  } catch {
    return claimersCache?.list ?? [];
  }
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

/* ----------------------- session-gas drip (namespaced) -------------------- */
// The /api/session-gas route drips a little SUI to a delegated-session key so it can
// self-fund gas (see [[sessions-delegated-trading]]). It shares this store's Redis /
// in-process backing, but under its own `sgas:` prefix so it never collides with the
// starter grant's ledger or shares its daily cap. Unlike the starter grant there's NO
// permanent "done" marker — a session key legitimately needs re-funding once its gas
// runs low — just a short cooldown, an in-flight lock, and a global daily cap.

/** Session-gas in-flight lock lifetime (a drip is a single fast transfer). */
const GAS_LOCK_TTL = 60;
/** Per-key cooldown: at most one drip per key per this window (abuse/drain guard). */
const GAS_COOLDOWN_TTL = 60 * 20; // 20 min

const gasLockKey = (addr: string) => `sgas:lock:${addr}`;
const gasRecentKey = (addr: string) => `sgas:recent:${addr}`;
const gasDayKey = () => `sgas:daily:${utcDay()}`;

const memGasLock = new Map<string, number>(); // addr -> lock expiry epoch ms
const memGasRecent = new Map<string, number>(); // addr -> cooldown expiry epoch ms
let memGasDay = '';
let memGasCount = 0;
function memGasRollDay() {
  const d = utcDay();
  if (d !== memGasDay) {
    memGasDay = d;
    memGasCount = 0;
  }
}

/** Take the session-gas in-flight lock (false if another drip is mid-flight). */
export async function acquireGasDripLock(address: string): Promise<boolean> {
  if (redis) {
    const r = await redis.set(gasLockKey(address), '1', { nx: true, ex: GAS_LOCK_TTL });
    return r === 'OK';
  }
  const now = Date.now();
  const exp = memGasLock.get(address);
  if (exp && exp > now) return false;
  memGasLock.set(address, now + GAS_LOCK_TTL * 1000);
  return true;
}

/** Release the session-gas in-flight lock (always call in a finally). */
export async function releaseGasDripLock(address: string): Promise<void> {
  if (redis) {
    await redis.del(gasLockKey(address));
    return;
  }
  memGasLock.delete(address);
}

/** True if this key was dripped within the cooldown window (refuse another). */
export async function recentlyDripped(address: string): Promise<boolean> {
  if (redis) return (await redis.exists(gasRecentKey(address))) === 1;
  const exp = memGasRecent.get(address);
  return !!exp && exp > Date.now();
}

/** Record a successful drip (starts the per-key cooldown + bumps the daily count). */
export async function markDripped(address: string): Promise<void> {
  if (redis) {
    await redis.set(gasRecentKey(address), '1', { ex: GAS_COOLDOWN_TTL });
    const n = await redis.incr(gasDayKey());
    if (n === 1) await redis.expire(gasDayKey(), DAY_TTL);
    return;
  }
  memGasRecent.set(address, Date.now() + GAS_COOLDOWN_TTL * 1000);
  memGasRollDay();
  memGasCount += 1;
}

/** Session-gas drips paid today (UTC) — the global circuit breaker. */
export async function gasDripDailyCount(): Promise<number> {
  if (redis) return (await redis.get<number>(gasDayKey())) ?? 0;
  memGasRollDay();
  return memGasCount;
}
