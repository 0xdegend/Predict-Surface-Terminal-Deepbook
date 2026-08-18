/**
 * closed-roots-guard.ts — a sticky memory of position roots we have already seen
 * FULLY CLOSED, so a later read that momentarily fails to see the closing redeem can
 * never resurrect a paid position.
 *
 * WHY THIS EXISTS. Open positions are re-derived every poll by netting `Σ minted −
 * Σ closed` per `position_root_id` (foldOpenPositions). The closing redeem of a
 * settled winner is the protocol KEEPER's permissionless auto-redeem, captured only
 * by a per-market GraphQL scan that can 429 on a refetch burst (see
 * [[keeper-redeem-read-gap]]). When that scan comes back empty, the redeem is
 * "missing", the root nets > 0 again, and the already-paid position flashes back as a
 * "Paying out / Claim" card for a poll before the next read folds it away — the
 * visible flicker, worst on a fresh reload (which is exactly when the in-memory set is
 * empty). This guard remembers the close and suppresses the resurrection.
 *
 * TWO INVARIANTS make it safe:
 *  1. WRITE ONLY ON A CONFIRMED CLOSE. A root is marked closed only when the fold saw
 *     its mint AND netted <= 0 — i.e. the closing redeem was positively read. A failed
 *     scan yields fewer closes, never a false close, so it can never poison the guard.
 *  2. A CLOSED ROOT NEVER REOPENS. `position_root_id` is unique per position and a
 *     fully-redeemed root cannot gain quantity again, so suppressing a known-closed
 *     root is always correct. The TTL is storage hygiene, not correctness.
 *
 * The guard is client state: it persists to localStorage so a reload keeps the memory
 * (the empty-set-on-reload case is the whole point). On the server / in tests there is
 * no persistence and it is a pure in-memory set, so behavior is unchanged there.
 */

export interface ClosedRootsGuard {
  /** True if this root was already seen fully closed (and still within TTL). */
  isClosed(root: string): boolean;
  /** Record a root as fully closed. No-op if already known or empty. */
  markClosed(root: string): void;
}

/** A closed root never legitimately reopens, so this is just storage hygiene: forget
 *  entries older than a day and keep the store bounded. Comfortably longer than any
 *  poll interval, so a transient failed scan can never outlive the memory of the close. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Cap the persisted set; evict the oldest closes first (least likely to still flicker). */
const DEFAULT_CAP = 800;

/** Where a guard reads/writes its persisted map. Injected so tests stay off localStorage. */
export interface ClosedRootsPersistence {
  load(): Record<string, number>;
  save(map: Record<string, number>): void;
}

export function createClosedRootsGuard(
  opts: {
    ttlMs?: number;
    cap?: number;
    now?: () => number;
    persistence?: ClosedRootsPersistence | null;
  } = {},
): ClosedRootsGuard {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cap = opts.cap ?? DEFAULT_CAP;
  const now = opts.now ?? Date.now;
  const persistence = opts.persistence ?? null;
  const map = new Map<string, number>(); // root -> closedAt (ms)

  // Hydrate from persistence, dropping anything already past its TTL.
  if (persistence) {
    const cutoff = now() - ttl;
    for (const [root, ts] of Object.entries(persistence.load())) {
      if (typeof ts === 'number' && ts >= cutoff) map.set(root, ts);
    }
  }

  const prune = () => {
    const cutoff = now() - ttl;
    for (const [root, ts] of map) if (ts < cutoff) map.delete(root);
    if (map.size > cap) {
      // Evict oldest until back under the cap.
      const oldestFirst = [...map.entries()].sort((a, b) => a[1] - b[1]);
      const drop = map.size - cap;
      for (let i = 0; i < drop; i++) map.delete(oldestFirst[i][0]);
    }
  };

  const persist = () => {
    if (!persistence) return;
    persistence.save(Object.fromEntries(map));
  };

  return {
    isClosed(root: string): boolean {
      if (!root) return false;
      const ts = map.get(root);
      if (ts == null) return false;
      if (ts < now() - ttl) {
        map.delete(root);
        return false;
      }
      return true;
    },
    markClosed(root: string): void {
      if (!root || map.has(root)) return;
      map.set(root, now());
      prune();
      persist();
    },
  };
}

/* -------------------------- browser singleton registry -------------------------- */

const registry = new Map<string, ClosedRootsGuard>();

/**
 * The shared guard for a scope (the wallet owner, else the account id). One instance per
 * scope so every hook folding the same account's positions shares the memory; localStorage
 * backed in the browser, pure in-memory everywhere else. Scoping by owner is hygiene only —
 * root ids are globally unique, so a guard can never suppress another account's position.
 */
export function getClosedRootsGuard(scope: string): ClosedRootsGuard {
  const key = scope || 'anon';
  const existing = registry.get(key);
  if (existing) return existing;
  const guard = createClosedRootsGuard({ persistence: browserPersistence(`skew.v2.closedRoots.${key}`) });
  registry.set(key, guard);
  return guard;
}

/** localStorage-backed persistence, or null when there is no usable localStorage
 *  (SSR, privacy mode, quota). All access is defensive: a storage failure degrades the
 *  guard to in-memory, never throws. */
function browserPersistence(storageKey: string): ClosedRootsPersistence | null {
  if (typeof window === 'undefined') return null;
  let store: Storage;
  try {
    store = window.localStorage;
    if (!store) return null;
  } catch {
    return null;
  }
  return {
    load() {
      try {
        const raw = store.getItem(storageKey);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
      } catch {
        return {};
      }
    },
    save(map: Record<string, number>) {
      try {
        store.setItem(storageKey, JSON.stringify(map));
      } catch {
        // Quota / disabled storage: keep running in-memory.
      }
    },
  };
}
