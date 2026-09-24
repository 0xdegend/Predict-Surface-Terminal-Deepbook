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
 *   grant:done:<scope>:<addr>  permanent "already funded" marker (set only after payout),
 *                      scoped to the NETWORK and the COLLATERAL COIN the grant paid in —
 *                      see grantScope
 *   grant:lock:<addr>  short-lived in-flight lock (NX + TTL) — kills the race
 *                      where two concurrent requests both pass the done-check
 *   grant:daily:<day>  shared daily payout counter (global spend circuit breaker)
 */
import { Redis } from '@upstash/redis';
import { ACTIVE_NETWORK, type SuiNetwork } from '@/config/predict';

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

/**
 * Ledger namespace for the coin a grant pays in.
 *
 * The "already funded" marker MUST be scoped to the collateral, not just the address. A
 * deployment that publishes its own coin makes every prior payout worthless: 9-12 replaced
 * `dusdc::DUSDC` with `usdc::USDC`, so every wallet the faucet had ever funded held a dead
 * coin, yet an address-only marker still read as a genuine payout and refused them the USDC
 * grant they now needed — funded, welcomed, and unable to place a single bet, with no way
 * out but manual KV surgery. Scoping by coin makes each collateral its own once-per-address
 * ledger: a DUSDC payout can never block a USDC grant, and the NEXT deployment that mints
 * its own coin gets a fresh ledger for free, with no code change and nothing to delete.
 *
 * The tag is readable on purpose (`usdc-c02855`, `dusdc-e95040`) because the operator
 * diagnostic for this ledger is an Upstash GET on the key — an opaque hash would hide which
 * deployment a marker belongs to. Module name + package prefix keeps it one key segment
 * (no `:`) and distinct across packages that reuse a module name.
 */
export function grantScope(coinType: string, network: SuiNetwork = ACTIVE_NETWORK): string {
  const [pkg = '', module] = coinType.split('::');
  const short = pkg.replace(/^0x/, '').slice(0, 6).toLowerCase();
  const mod = (module ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tag = mod || short ? `${mod || 'coin'}-${short || 'none'}` : 'unscoped';
  // Testnet keeps its historical spelling, so the ledger built up to 2026-09-24 is
  // untouched and no existing wallet is silently re-offered a grant. Everything else is
  // prefixed. See NETWORK_PREFIX.
  return network === 'testnet' ? tag : `${network}-${tag}`;
}

/**
 * The marker prefix that says "not testnet".
 *
 * Every key written before 2026-09-24 predates mainnet and carries no network segment, so
 * ABSENT MEANS TESTNET — the same rule `carriedSnapshots` uses for leaderboard seeds with
 * no `network` field. Both rules exist for the same reason: play-money onboarding must
 * never appear on a real-money board.
 */
const NETWORK_PREFIX = 'mainnet-';

/** Which network a done-marker key body belongs to. Addresses are 0x-hex, so a legacy
 *  un-scoped body can never collide with the prefix. */
function networkFromDoneKey(body: string): SuiNetwork {
  return body.startsWith(NETWORK_PREFIX) ? 'mainnet' : 'testnet';
}

const doneKey = (scope: string, addr: string) => `grant:done:${scope}:${addr}`;
const lockKey = (addr: string) => `grant:lock:${addr}`;
const utcDay = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const dayKey = () => `grant:daily:${utcDay()}`;

/* ---------------- in-process fallback (no Redis configured) ---------------- */

const memDone = new Map<string, string>(); // `${scope}:${addr}` -> payout digest (or '1' sentinel)
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

/** Has this address already been funded IN THIS COIN? (permanent marker) */
export async function hasGranted(scope: string, address: string): Promise<boolean> {
  if (redis) return (await redis.exists(doneKey(scope, address))) === 1;
  return memDone.has(`${scope}:${address}`);
}

/** The stored "funded" marker value, or null if none. A real payout stores its
 *  tx DIGEST; the old balance-gate stored the sentinel '1'. The route uses this
 *  to tell a genuine prior payout from a stale/false marker (self-healing). */
export async function getGranted(scope: string, address: string): Promise<string | null> {
  if (redis) return (await redis.get<string | number>(doneKey(scope, address)))?.toString() ?? null;
  return memDone.get(`${scope}:${address}`) ?? null;
}

/** Remove a "funded" marker — used to heal a stale/false one so a genuinely
 *  never-funded wallet isn't blocked forever. */
export async function clearGranted(scope: string, address: string): Promise<void> {
  if (redis) {
    await redis.del(doneKey(scope, address));
    return;
  }
  memDone.delete(`${scope}:${address}`);
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
export async function markGranted(scope: string, address: string, digest = '1'): Promise<void> {
  if (redis) {
    await redis.set(doneKey(scope, address), digest, { ex: DONE_TTL });
    return;
  }
  memDone.set(`${scope}:${address}`, digest);
}

/**
 * Every wallet that has claimed the starter grant, lowercased. Enumerated from the
 * permanent `grant:done:*` markers via a cursor SCAN (bounded per iteration so it
 * never blocks the store), deduped.
 *
 * SCOPED TO ONE NETWORK, and cumulative across DEPLOYMENTS within it (the leaderboard
 * badges anyone who onboarded through the app on this chain, whenever they did). The network
 * gate was added 2026-09-24 after 34 testnet grant wallets appeared on the freshly-empty
 * mainnet Skew board, each carrying a participation point, on a chain where nobody had
 * traded yet: the board read as busy when it should have read as day one. Markers used to be
 * keyed by address alone;
 * they are now scoped by collateral coin (see grantScope), so both shapes coexist in the
 * store — `grant:done:<addr>` written before the 9-12 coin swap, `grant:done:<scope>:<addr>`
 * after. `addressFromDoneKey` reads the address out of either, so no historical claimer
 * drops off the board and the old markers can be left to age out on their own TTL rather
 * than being deleted. Cached briefly in-process because the leaderboard route asks for it on
 * every request; falls back to the in-process ledger when no Redis is configured (local dev).
 * Never throws — a store hiccup yields the last good list (or empty), so the board renders.
 */
const CLAIMERS_TTL_MS = 5 * 60_000;
let claimersCache: { at: number; network: SuiNetwork; list: string[] } | null = null;

/** The address out of a done-marker key body, for BOTH shapes: a legacy un-scoped
 *  `<addr>` (no colon — the whole thing is the address) and a scoped `<scope>:<addr>`
 *  (the address is the final segment). Scope tags never contain a colon, so the last
 *  colon is an unambiguous split point. */
function addressFromDoneKey(body: string): string {
  return body.slice(body.lastIndexOf(':') + 1).toLowerCase();
}

export async function listFaucetClaimers(network: SuiNetwork = ACTIVE_NETWORK): Promise<string[]> {
  // The cache exists to spare Redis a full SCAN on every leaderboard request. The
  // in-process fallback is a local Map, so caching it buys nothing and would only hide a
  // marker written moments ago.
  if (redis && claimersCache && claimersCache.network === network && Date.now() - claimersCache.at < CLAIMERS_TTL_MS) {
    return claimersCache.list;
  }
  const prefix = 'grant:done:';
  const mine = (body: string) => networkFromDoneKey(body) === network;
  try {
    let list: string[];
    if (redis) {
      const seen = new Set<string>();
      let cursor = '0';
      let guard = 0;
      do {
        const [next, keys] = await redis.scan(cursor, { match: `${prefix}*`, count: 500 });
        for (const k of keys) {
          const body = k.slice(prefix.length);
          if (mine(body)) seen.add(addressFromDoneKey(body));
        }
        cursor = next;
      } while (cursor !== '0' && ++guard < 1000);
      list = [...seen];
    } else {
      list = [...new Set([...memDone.keys()].filter(mine).map(addressFromDoneKey))];
    }
    if (redis) claimersCache = { at: Date.now(), network, list };
    return list;
  } catch {
    // Only ever serve a stale list back to the network it was built for.
    return claimersCache?.network === network ? claimersCache.list : [];
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
/** Per-key cooldown: a SHORT anti-hammer only. The real gate is the balance ceiling in
 *  /api/session-gas (a genuinely low key tops up freely; a just-topped key sits above the
 *  ceiling, so this window only ever bites a tight drain-and-redrip loop). */
const GAS_COOLDOWN_TTL = 60; // 60s

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
