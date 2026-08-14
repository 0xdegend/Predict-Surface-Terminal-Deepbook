/**
 * lib/analytics/v2-style-indexer.ts — the ACCUMULATING trader-style roster.
 *
 * Trader styles need every trader's full betting history, but the per-market order
 * fan-out the route used before was badly truncated (newest ~50 markets, ~50 mints
 * each, an ~8h window), so real traders rarely cleared the sample floor and the tab
 * read empty. This keeps a running per-owner style accumulator and folds in only the
 * `OrderMinted` events since its last cursor (scanEventsSince), so the roster is
 * complete and never re-windowed — the same pattern the leaderboard indexer uses,
 * but scoped to MINTS only (the classifier is purely mint-side) and folding into a
 * StyleAccumulator instead of a PnL tally.
 *
 * ISOLATED from the leaderboard on purpose: its own KV namespace + guard, so it has
 * zero blast radius on the (sensitive) board. Two layers — an in-process snapshot on
 * globalThis and a durable KV snapshot — bridge cold starts; a pkg + seedVersion guard
 * invalidates both on redeploy / logic change. Stale-while-revalidate: a request serves
 * the last-good roster immediately and refreshes in the background. Server-only.
 */
import { predictV2Config } from '@/config/predict';
import { scanEventsSince } from '@/lib/api/v2/onchain';
import { fromQuote, toFloat } from '@/config/scale';
import { kv } from '@/lib/server/kv';
import { orderSide } from './v2-aggregate';
import { emptyStyleAcc, foldMint, classifyAcc, type StyleAccumulator, type StyleArchetype } from './trader-style';
import type { V2TraderStyles, V2ClassifiedTrader, V2StyleBucket } from './v2-trader-style';

/** Re-scan at most once per this window (concurrent callers share the in-flight scan). */
const FRESH_MS = 30_000;
/** KV snapshot lifetime — a week; the guard resets it on redeploy anyway. */
const KV_TTL_S = 7 * 86_400;
/** Pages of OrderMinted a single catch-up walks (50/page). First run backfills the newest
 *  ~1500 mints — enough distinct traders for the roster while staying GENTLE on the shared,
 *  rate-limited GraphQL endpoint (a heavier per-owner fan-out here is what tripped its 429);
 *  steady state stops at the cursor within a page or two. Traders buried past this window
 *  get folded in the moment they trade again (the incremental delta). */
const BACKFILL_PAGES = 30;
/** Roster rows returned to the client (paginated there). Distribution + total count ALL. */
const ROSTER_MAX = 200;
/** Bump when the fold/seed logic changes so a stale KV tally is discarded, not reused. */
const SEED_VERSION = 1;

const orderMintedType = () => `${predictV2Config.packages.predict}::order_events::OrderMinted`;
const kvKey = () => `styles:idx:${predictV2Config.packages.predict}`;

interface Persisted {
  /** owner → their accumulated style inputs. */
  accs: Record<string, StyleAccumulator>;
  /** Newest OrderMinted event folded, for the next incremental scan. */
  cursor: string | null;
  builtAtMs: number;
  pkg: string;
  seedVersion: number;
}

interface Cache {
  snap: Persisted | null;
  inflight: Promise<Persisted> | null;
}
const g = globalThis as unknown as { __styleIndexer?: Cache };
const cache: Cache = (g.__styleIndexer ??= { snap: null, inflight: null });

const isCurrent = (p: Persisted | null | undefined): p is Persisted =>
  !!p && p.pkg === predictV2Config.packages.predict && p.seedVersion === SEED_VERSION;
const isFresh = (p: Persisted | null | undefined): p is Persisted =>
  isCurrent(p) && Date.now() - p.builtAtMs < FRESH_MS;

const freshEmpty = (): Persisted => ({
  accs: {},
  cursor: null,
  builtAtMs: 0,
  pkg: predictV2Config.packages.predict,
  seedVersion: SEED_VERSION,
});

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
      /* KV read failed — rebuild forward from an empty tally. */
    }
  }
  return freshEmpty();
}

/** Fold one mint record (a parsed event json, or a V2OrderEvent) into its owner's acc. */
function foldMintRecord(accs: Record<string, StyleAccumulator>, p: Record<string, unknown>): void {
  const owner = String(p.owner ?? '');
  if (!owner) return;
  const cost = fromQuote(Number(p.net_premium ?? 0));
  if (cost <= 0) return;
  const side = orderSide(p.lower_tick, p.higher_tick);
  const entry = toFloat(Number(p.entry_probability ?? 0));
  const market = String(p.expiry_market_id ?? '');
  let acc = accs[owner];
  if (!acc) {
    acc = emptyStyleAcc();
    accs[owner] = acc;
  }
  foldMint(acc, { cost, entry, side, market });
}

/**
 * FIRST RUN — seed the empty accumulator from the newest `BACKFILL_PAGES` of `OrderMinted`.
 * Deliberately backfill-ONLY (no per-owner fan-out): the fan-out was several GraphQL reads
 * per owner over dozens of owners, a burst that reliably tripped the shared endpoint's 429
 * and left the whole seed failing empty. The backfill alone already carries every recently
 * active trader, and the incremental delta folds in anyone else the moment they next trade.
 * The cursor is the backfill's newest, so steady state folds only newer mints.
 */
async function seedFirstRun(accs: Record<string, StyleAccumulator>): Promise<string | null> {
  const backfill = await scanEventsSince({ MoveEventType: orderMintedType() }, null, BACKFILL_PAGES);
  for (const e of backfill.events) if (e.parsedJson) foldMintRecord(accs, e.parsedJson);
  return backfill.cursor;
}

/** Fold the mints since the last cursor into the tally, then write through both layers. */
async function runAccumulate(): Promise<Persisted> {
  const prev = await loadPersisted();
  const firstRun = prev.cursor === null && prev.builtAtMs === 0;
  let cursor: string | null;
  if (firstRun) {
    cursor = await seedFirstRun(prev.accs);
  } else {
    const scan = await scanEventsSince({ MoveEventType: orderMintedType() }, prev.cursor, BACKFILL_PAGES);
    for (const e of scan.events) if (e.parsedJson) foldMintRecord(prev.accs, e.parsedJson);
    cursor = scan.cursor;
  }
  const snap: Persisted = {
    accs: prev.accs,
    cursor,
    builtAtMs: Date.now(),
    pkg: predictV2Config.packages.predict,
    seedVersion: SEED_VERSION,
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

/**
 * The current tally, STALE-WHILE-REVALIDATE. A styles request must never block on a live
 * scan when we already hold a usable tally: serve it now and let the refresh land for a
 * later request. Only a cold, never-seeded instance waits for the first build. The scan
 * is shared across concurrent callers and re-runs at most once per FRESH_MS.
 */
async function current(): Promise<Persisted> {
  if (isFresh(cache.snap)) return cache.snap;
  const prev = await loadPersisted();
  cache.inflight ??= runAccumulate().finally(() => {
    cache.inflight = null;
  });
  if (isCurrent(prev) && prev.builtAtMs > 0) {
    void cache.inflight.catch(() => {});
    return prev;
  }
  try {
    return await cache.inflight;
  } catch {
    return prev;
  }
}

export interface V2StylesRoster extends V2TraderStyles {
  available: boolean;
  asOf: number;
}

/** The complete-roster trader styles, classified from the accumulated all-time tally. */
export async function getStyleRoster(): Promise<V2StylesRoster> {
  const snap = await current();
  const asOf = Date.now();

  const classified: V2ClassifiedTrader[] = [];
  for (const [owner, acc] of Object.entries(snap.accs)) {
    const style = classifyAcc(acc);
    if (style.primary) classified.push({ owner, style, volume: style.stats.volume });
  }
  classified.sort((a, b) => b.volume - a.volume);

  const counts = new Map<StyleArchetype['id'], { label: string; count: number }>();
  for (const c of classified) {
    const p = c.style.primary!;
    const cur = counts.get(p.id);
    if (cur) cur.count += 1;
    else counts.set(p.id, { label: p.label, count: 1 });
  }
  const distribution: V2StyleBucket[] = [...counts.entries()]
    .map(([id, v]) => ({ id, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);

  return {
    available: snap.builtAtMs > 0,
    asOf,
    traders: classified.slice(0, ROSTER_MAX),
    distribution,
    total: classified.length,
  };
}
