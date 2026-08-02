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
import { kv } from '@/lib/server/kv';
import type { V2LeaderboardRow } from './v2';
import type { V2OrderEvent } from '@/lib/api/v2/types';

/** Re-scan at most once per this window (concurrent callers share the in-flight scan). */
const FRESH_MS = 20_000;
/** KV snapshot lifetime — a week; the pkg guard resets it on redeploy anyway. */
const KV_TTL_S = 7 * 86_400;
/** Max pages/type a single catch-up walks. First run backfills the newest ~2000/type;
 *  steady state stops at the cursor within a page or two, so this cap is rarely hit. */
const BACKFILL_PAGES = 40;
/** Drop CLOSED mints older than this from the join set (no more redeems expected). */
const OPEN_PRUNE_MS = 3 * 86_400_000;
/** Hard cap on retained open-mint terms, so `open` stays bounded under a bot. */
const OPEN_MAX = 20_000;

const kvKey = () => `lb:idx:${predictV2Config.packages.predict}`;

interface Persisted {
  state: LbState;
  cursors: OrderCursors;
  builtAtMs: number;
  pkg: string;
}

interface Cache {
  snap: Persisted | null;
  inflight: Promise<Persisted> | null;
}
const g = globalThis as unknown as { __lbIndexer?: Cache };
const cache: Cache = (g.__lbIndexer ??= { snap: null, inflight: null });

const forThisPkg = (p: Persisted | null | undefined): p is Persisted =>
  !!p && p.pkg === predictV2Config.packages.predict;
const isFresh = (p: Persisted | null | undefined): p is Persisted =>
  forThisPkg(p) && Date.now() - p.builtAtMs < FRESH_MS;

const freshEmpty = (): Persisted => ({
  state: emptyLbState(),
  cursors: {},
  builtAtMs: 0,
  pkg: predictV2Config.packages.predict,
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
  if (forThisPkg(cache.snap)) return cache.snap;
  if (kv) {
    try {
      const cached = await kv.get<Persisted>(kvKey());
      if (forThisPkg(cached)) {
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
  const owners = code ? await onchainSkewOwners(code).catch(() => [] as string[]) : [];
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
  };
  cache.snap = snap;
  if (kv) {
    try {
      await kv.set(kvKey(), snap, { ex: KV_TTL_S });
    } catch {
      /* best-effort — the in-process tally still serves this instance. */
    }
  }
  return snap;
}

/** Current tally, re-scanning at most once per FRESH_MS (concurrent callers share it). */
async function current(): Promise<Persisted> {
  if (isFresh(cache.snap)) return cache.snap;
  cache.inflight ??= runAccumulate().finally(() => {
    cache.inflight = null;
  });
  try {
    return await cache.inflight;
  } catch {
    return cache.snap ?? freshEmpty();
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
export async function getLeaderboardBoards(): Promise<LeaderboardBoards> {
  const snap = await current();
  const now = Date.now();
  const code = predictV2Config.builderCodeId;
  return {
    all: finalizeRows(snap.state, code, now, 'all'),
    skew: finalizeRows(snap.state, code, now, 'skew'),
    builtAtMs: snap.builtAtMs,
  };
}
