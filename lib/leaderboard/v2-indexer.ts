/**
 * lib/leaderboard/v2-indexer.ts — the persistent, ACCUMULATING leaderboard indexer.
 *
 * The problem it solves: every other read path scans a bounded window of recent events
 * and filters, so a high-frequency bot buries real traders and the board truncates.
 * This instead keeps a running per-owner tally in KV and, each cycle, folds in ONLY the
 * events since its last cursor (see scanOrderEventsSince). Nothing is ever re-truncated:
 * the tally grows and both boards are served from complete history.
 *
 * Two layers, mirroring lib/leaderboard/v2-onchain-store.ts: an in-process snapshot on
 * globalThis (fast path within a warm instance) and a durable KV snapshot that bridges
 * cold starts. A `pkg` guard invalidates both on redeploy. Concurrent callers share one
 * scan; a scan failure serves the last good tally rather than erroring. Server-only.
 */
import { predictV2Config } from '@/config/predict';
import {
  scanOrderEventsSince,
  onchainSkewOwners,
  onchainOwnerOrders,
  type OrderCursors,
} from '@/lib/api/v2/onchain';
import { emptyLbState, foldOrderEvents, finalizeRows, type LbState } from './v2-aggregate';
import { LEGACY_OWNERS } from './legacy-carryover';
import { kv } from '@/lib/server/kv';
import type { V2LeaderboardRow } from './v2';
import type { V2OrderEvent } from '@/lib/api/v2/types';

/** Re-scan at most once per this window (concurrent callers share the in-flight scan). */
const FRESH_MS = 20_000;
/**
 * A forced refresh waits this long for the scan before answering with the last tally
 * (the scan keeps running and lands for the next request). A normal catch-up is a few
 * pages per event type, two or three seconds; this is a ceiling for the bad day, and
 * it sits inside a serverless function's budget.
 */
const FORCE_DEADLINE_MS = 12_000;
/**
 * Write the tally to the store at most this often.
 *
 * The tally is a multi-MB JSON document (the join set of open mints dominates: ~15k
 * entries on 8-06), and it used to be written after EVERY 20s cycle, on the request
 * path. A forced refresh therefore waited on a 4MB upload, which from a slow uplink is
 * a minute or more, and every later request shared that same in-flight cycle. The
 * write is now off the request path, single-flight, and throttled; the in-process
 * tally is the live truth either way, and a cold instance rebuilds forward from the
 * last persisted cursors, so a write that is a couple of minutes behind costs nothing.
 */
const PERSIST_MIN_MS = 2 * 60_000;
/** KV snapshot lifetime — a week; the pkg guard resets it on redeploy anyway. */
const KV_TTL_S = 7 * 86_400;
/** Max pages/type a single catch-up walks. First run backfills the newest ~2000/type;
 *  steady state stops at the cursor within a page or two, so this cap is rarely hit. */
const BACKFILL_PAGES = 40;
/** Drop CLOSED mints older than this from the join set (no more redeems expected). */
const OPEN_PRUNE_MS = 3 * 86_400_000;
/** Hard cap on retained open-mint terms, so `open` stays bounded under a bot. */
const OPEN_MAX = 20_000;
/** Bump when the SEED logic changes (e.g. which owners get fanned out) so a stale KV
 *  tally built by the old seed is discarded and rebuilt, rather than lingering for its
 *  week TTL. Part of the persisted guard alongside `pkg`. */
const SEED_VERSION = 3;

const kvKey = () => `lb:idx:${predictV2Config.packages.predict}`;

interface Persisted {
  state: LbState;
  cursors: OrderCursors;
  builtAtMs: number;
  pkg: string;
  /** Seed-logic version this tally was built under (see SEED_VERSION). */
  seedVersion: number;
}

interface PersistState {
  /** The store write in flight, if any (single-flight: a new one waits for it). */
  inflight: Promise<void> | null;
  /** When the last write STARTED (ms), for the throttle. */
  lastAt: number;
}
interface Cache {
  snap: Persisted | null;
  inflight: Promise<Persisted> | null;
  persist?: PersistState;
}
const g = globalThis as unknown as { __lbIndexer?: Cache };
const cache: Cache = (g.__lbIndexer ??= { snap: null, inflight: null });

/** Should a tally be written now? Not while another write is in flight, and not sooner
 *  than `minMs` after the last one started. Pure, so the throttle is testable. */
export function persistDue(now: number, lastAt: number, inflight: boolean, minMs = PERSIST_MIN_MS): boolean {
  if (inflight) return false;
  if (lastAt === 0) return true; // this process has never written: the store may be far behind
  return now - lastAt >= minMs;
}

/** Resolve with `p`'s value, or `fallback` once `ms` has passed (or if `p` fails). The
 *  promise itself is left running: a slow scan still lands for the next request. */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/**
 * Write the tally through to the store, off the request path. Fire-and-forget: nothing
 * awaits it, a failure is swallowed (the in-process tally still serves this instance),
 * and the throttle means a busy instance uploads once every couple of minutes rather
 * than every cycle. Each cycle calls this with its fresh snapshot, so a write that was
 * throttled is simply superseded by a newer one when the window opens.
 */
function persistSoon(snap: Persisted): void {
  if (!kv) return;
  const p = (cache.persist ??= { inflight: null, lastAt: 0 });
  if (!persistDue(Date.now(), p.lastAt, p.inflight !== null)) return;
  p.lastAt = Date.now();
  p.inflight = kv
    .set(kvKey(), snap, { ex: KV_TTL_S })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      p.inflight = null;
    });
}

/** A persisted tally is usable only if it was built for THIS package AND under the
 *  current seed logic — otherwise it's discarded and rebuilt from scratch. */
const isCurrent = (p: Persisted | null | undefined): p is Persisted =>
  !!p && p.pkg === predictV2Config.packages.predict && p.seedVersion === SEED_VERSION;
const isFresh = (p: Persisted | null | undefined): p is Persisted =>
  isCurrent(p) && Date.now() - p.builtAtMs < FRESH_MS;

const freshEmpty = (): Persisted => ({
  state: emptyLbState(),
  cursors: {},
  builtAtMs: 0,
  pkg: predictV2Config.packages.predict,
  seedVersion: SEED_VERSION,
});

/** Keep `open` bounded: evict aged-out closed mints, then hard-cap oldest-first. */
function pruneOpen(state: LbState): void {
  const cutoff = Date.now() - OPEN_PRUNE_MS;
  for (const [root, om] of Object.entries(state.open)) {
    if (om.redeemed && om.mintMs < cutoff) delete state.open[root];
  }
  const roots = Object.keys(state.open);
  if (roots.length > OPEN_MAX) {
    roots.sort((a, b) => state.open[a].mintMs - state.open[b].mintMs);
    for (const root of roots.slice(0, roots.length - OPEN_MAX)) delete state.open[root];
  }
}

/** The last-good tally: in-process snapshot, else the durable KV one, else empty. */
async function loadPersisted(): Promise<Persisted> {
  if (isCurrent(cache.snap)) return cache.snap;
  if (kv) {
    try {
      const cached = await kv.get<Persisted>(kvKey());
      if (isCurrent(cached)) {
        cache.snap = cached;
        return cached;
      }
    } catch {
      /* KV read failed — start from a fresh tally and rebuild forward. */
    }
  }
  return freshEmpty();
}

/** A stable identity for an order event, to dedupe the first-run backfill against the
 *  app-user seed (one mint per root; a redeem is keyed by root + closed size + time). */
const evKey = (e: V2OrderEvent): string =>
  e.kind === 'order_minted'
    ? `m:${e.position_root_id}`
    : `${e.kind}:${e.position_root_id}:${e.quantity_closed ?? ''}:${e.checkpoint_timestamp_ms ?? ''}`;

function dedupe(events: V2OrderEvent[]): V2OrderEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = evKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * FIRST RUN ONLY — seed the empty tally. The backfill window is itself bot-dominated
 * (the bot can own ~all of the newest N events), so it alone would bury our app users.
 * We therefore also read each app user's COMPLETE history by tx-sender (whale-immune)
 * and dedupe it against the backfill, so no attributed trader is missing from the start.
 * The cursor is set to the backfill's newest, so steady-state folds only newer events
 * and never re-counts the seed.
 */
async function seedFirstRun(state: LbState): Promise<OrderCursors> {
  const code = predictV2Config.builderCodeId;
  const backfill = await scanOrderEventsSince({}, BACKFILL_PAGES);
  // Owners to fan out COMPLETELY (by tx-sender, bot-immune) so they're never buried in
  // the bot-dominated backfill window. Three sources, unioned:
  //   1. builder-code owners — every wallet that attached OUR code (only when the code
  //      is registered on this deployment);
  //   2. the carried-over 6-24 wallets — our known real traders, so a fresh redeploy
  //      with the code not yet wired still shows them on the VENUE board once they trade;
  //   3. featured wallets (config), same treatment.
  // Without (2)/(3) a real trader with a handful of bets vanishes from the venue board
  // whenever the code isn't wired yet. Deduped against the backfill so nothing doubles.
  const codeOwners = code ? await onchainSkewOwners(code).catch(() => [] as string[]) : [];
  const owners = [
    ...new Set(
      [...codeOwners, ...LEGACY_OWNERS, ...predictV2Config.featuredWallets].map((o) => o.toLowerCase()),
    ),
  ];
  const seed = (
    await Promise.all(owners.map((o) => onchainOwnerOrders(o, 300).catch(() => [] as V2OrderEvent[])))
  ).flat();
  foldOrderEvents(state, dedupe([...backfill.events, ...seed]), code);
  return backfill.cursors;
}

/** Fold the events since the last cursor into the persisted tally, then write through. */
async function runAccumulate(): Promise<Persisted> {
  const prev = await loadPersisted();
  const firstRun = Object.keys(prev.cursors).length === 0;
  let cursors: OrderCursors;
  if (firstRun) {
    cursors = await seedFirstRun(prev.state);
  } else {
    const scan = await scanOrderEventsSince(prev.cursors, BACKFILL_PAGES);
    foldOrderEvents(prev.state, scan.events, predictV2Config.builderCodeId);
    cursors = scan.cursors;
  }
  pruneOpen(prev.state);
  const snap: Persisted = {
    state: prev.state,
    cursors,
    builtAtMs: Date.now(),
    pkg: predictV2Config.packages.predict,
    seedVersion: SEED_VERSION,
  };
  cache.snap = snap;
  persistSoon(snap); // never awaited: the store write is not part of the cycle's latency
  return snap;
}

/**
 * The current tally, STALE-WHILE-REVALIDATE. A leaderboard request must never block
 * on a live event scan: if we already hold a usable tally (the in-process snapshot,
 * or the KV one on a cold instance), we serve it IMMEDIATELY and let the refresh run
 * in the background — it lands for a later request. Only a cold, never-seeded instance
 * (no KV snapshot yet) waits for the first build. The scan is shared across concurrent
 * callers and re-runs at most once per FRESH_MS.
 *
 * Safe to serve `prev` while the background scan runs: `getLeaderboardBoards` reads it
 * via the synchronous `finalizeRows` the instant we return, before the scan's first
 * `await` yields back to mutate the state (JS is single-threaded).
 */
async function current(force = false): Promise<Persisted> {
  if (!force && isFresh(cache.snap)) return cache.snap;
  // Last-good tally (in-process, else KV) — a fast read that also warms cache.snap.
  const prev = await loadPersisted();
  cache.inflight ??= runAccumulate().finally(() => {
    cache.inflight = null;
  });
  // An explicit refresh (force) waits for the scan so the response reflects a just-made
  // trade — but not forever. Past the deadline it answers with the last tally and the
  // scan lands for the next request, so a wedged upstream or a long catch-up can never
  // hold the button's spinner open indefinitely. A concurrent scan is shared, so
  // spamming the button never launches parallel scans. A cold, never-seeded instance
  // has nothing to fall back to, so that one case still waits for the first build.
  if (force) {
    if (!(isCurrent(prev) && prev.builtAtMs > 0)) {
      try {
        return await cache.inflight;
      } catch {
        return prev;
      }
    }
    return withDeadline(cache.inflight, FORCE_DEADLINE_MS, prev);
  }
  // Have something usable? Serve it now; the in-flight refresh updates it for next time.
  if (isCurrent(prev) && prev.builtAtMs > 0) {
    void cache.inflight.catch(() => {});
    return prev;
  }
  // Cold / never-seeded — nothing to serve yet, so wait for the first build.
  try {
    return await cache.inflight;
  } catch {
    return prev;
  }
}

export interface LeaderboardBoards {
  /** Whole-venue standings. */
  all: V2LeaderboardRow[];
  /** Only builder-code-attributed activity (bets placed through the app). */
  skew: V2LeaderboardRow[];
  /** When the tally was last advanced (ms). */
  builtAtMs: number;
}

/**
 * Both boards from the accumulated tally — complete history, never windowed. `all`
 * ranks the whole venue; `skew` ranks only app-attributed activity. Holding time is
 * computed to now at read, so open positions keep accruing without re-scanning.
 */
export async function getLeaderboardBoards(opts?: { force?: boolean }): Promise<LeaderboardBoards> {
  const snap = await current(opts?.force ?? false);
  const now = Date.now();
  const code = predictV2Config.builderCodeId;
  return {
    all: finalizeRows(snap.state, code, now, 'all'),
    skew: finalizeRows(snap.state, code, now, 'skew'),
    builtAtMs: snap.builtAtMs,
  };
}
