/**
 * lib/api/v2/onchain.ts — the on-chain read layer (7-29 and 8-06).
 *
 * These deployments have NO HTTP indexer, so these functions reconstruct the same
 * shapes the beta indexer returned (V2Market, PythObservation) directly from chain.
 * They are dispatched to from client.ts when `V2_IS_729_PLUS` (7-29 / 8-06), behind
 * the identical function signatures and TanStack keys, so no consumer or UI changes.
 *
 * Transports (all JSON-RPC removed — Sui is decommissioning it, testnet event queries
 * were disabled 2026-07-08):
 *   - EVENTS  -> GraphQL `events` (indexed, per-event timestamps). The sanctioned
 *     replacement; same endpoint the leaderboard's v2-onchain-events uses.
 *   - OBJECTS -> gRPC `getObject` (exact, low-latency point read).
 *   - TX-SCOPED events (by affected object) -> GraphQL `transactions` (the one read
 *     the event index can't express).
 *
 * Pure functions (no React) — work from Server Components, queryFns, and scripts.
 */
import { Transaction } from '@mysten/sui/transactions';
import { grpcRead, activeGrpcUrl } from '@/lib/sui/grpc-core';
import { predictV2Config, V2_IS_821_PLUS } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { loadSessionAddresses } from '@/lib/sui/v2/session';
import { PredictApiError } from '@/lib/api/client';
import { normalizeOrderEvent, normalizeMarketCreated, oracleReadTimestamp, isFullSettledClose } from './event-compat';
import { cadenceOf, CADENCE_PERIOD_MS, type V2Cadence } from '@/lib/markets/v2-discovery';
import type { ClosedRootsGuard } from '@/lib/portfolio/closed-roots-guard';
import type {
  V2Market,
  PythObservation,
  V2MarketState,
  V2Settlement,
  V2OrderEvent,
  V2OpenInterest,
  V2VaultFlush,
  V2VaultProfit,
  V2VaultSupplyFill,
  V2VaultWithdrawFill,
  V2VaultServerState,
  V2VaultCurrent,
  V2Position,
  V2BuilderFee,
} from './types';

interface GetOptions {
  revalidate?: number | false;
  signal?: AbortSignal;
}

interface SuiEvent {
  type?: string;
  timestampMs?: string | number;
  parsedJson?: Record<string, unknown>;
  /** Stable event position, for incremental cursoring (see scanEventsSince). */
  id?: { txDigest?: string; eventSeq?: string };
}

/** A stable event-id string ("txDigest:eventSeq") for cursor comparison. */
const eventId = (e: SuiEvent): string => `${e.id?.txDigest ?? ''}:${e.id?.eventSeq ?? ''}`;

interface EventPage {
  data: SuiEvent[];
  nextCursor: unknown;
  hasNextPage: boolean;
}

/** GraphQL RPC endpoint — the sanctioned replacement for the (now-removed) JSON-RPC
 *  event index. Sui disabled JSON-RPC event queries on testnet 2026-07-08; GraphQL's
 *  `events` connection is INDEXED (returns matches directly, whatever their age),
 *  unlike gRPC `listEvents` which scan-bounds each request and can silently miss sparse
 *  or old events (e.g. vault flushes). It also carries a per-event `timestamp`. Same
 *  endpoint + shape the leaderboard's v2-onchain-events already uses. */
const graphqlUrl = () => `https://graphql.${predictV2Config.network}.sui.io/graphql`;

/** The public GraphQL proxy 429s under load (Sui docs: prod wants a dedicated endpoint)
 *  and 503s on a hiccup. Retry those — honoring Retry-After, else exponential backoff —
 *  so a transient limit never fails a whole scan or the style/leaderboard seed. Success
 *  and every other status pass straight through unchanged. */
const EVENT_RETRY_MAX = 4;
const EVENT_RETRY_BASE_MS = 400;
const EVENT_RETRY_MAX_MS = 4_000;
/** Cap one GraphQL request. A proxy that holds a connection open without answering
 *  used to wedge the leaderboard's whole in-flight cycle (every later request shares
 *  it). With this, the request fails, the scan skips that type for the cycle, and the
 *  next cycle retries from the same cursor. */
const EVENT_FETCH_TIMEOUT_MS = 15_000;
/** The caller's signal, also cut off after `ms`. Older runtimes without the static
 *  helpers just keep the caller's signal. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== 'function') return signal;
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : signal;
}
const sleepMs = (wait: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, wait);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
async function postEvents(body: string, opts?: GetOptions): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(graphqlUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: withTimeout(opts?.signal, EVENT_FETCH_TIMEOUT_MS),
      body,
    });
    if ((res.status !== 429 && res.status !== 503) || attempt >= EVENT_RETRY_MAX) return res;
    const ra = Number(res.headers.get('retry-after'));
    const backoff =
      Number.isFinite(ra) && ra > 0 ? ra * 1_000 : Math.min(EVENT_RETRY_BASE_MS * 2 ** attempt, EVENT_RETRY_MAX_MS);
    await sleepMs(backoff + Math.random() * 200, opts?.signal);
  }
}

/** Translate the legacy JSON-RPC event filters this module builds into the GraphQL
 *  `EventFilter`. `MoveEventType` (event struct type) -> `type`; `MoveModule`
 *  (emitting module) -> `module` ("package::module"). The only two shapes callers pass. */
function toEventFilter(filter: unknown): { type: string } | { module: string } | { sender: string } {
  const f = filter as { MoveEventType?: string; Sender?: string; MoveModule?: { package?: string; module?: string } };
  if (f?.MoveEventType) return { type: f.MoveEventType };
  if (f?.Sender) return { sender: f.Sender }; // events from txs SENT by this address (FromAddress equivalent)
  if (f?.MoveModule?.package && f.MoveModule.module) {
    return { module: `${f.MoveModule.package}::${f.MoveModule.module}` };
  }
  throw new Error('onchain: unsupported event filter shape');
}

const EVENTS_QUERY = `query Events($filter: EventFilter!, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: $filter) {
    pageInfo { hasPreviousPage startCursor }
    edges { cursor node { timestamp contents { type { repr } json } } }
  }
}`;

interface GqlEventEdge {
  cursor?: string;
  node?: {
    timestamp?: string | null;
    contents?: { type?: { repr?: string } | null; json?: Record<string, unknown> | null } | null;
  };
}
interface GqlEventsResponse {
  data?: {
    events?: { pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null }; edges?: GqlEventEdge[] };
  };
  errors?: { message?: string }[];
}

/** GraphQL event edge -> the `SuiEvent` the builders consume. The Relay `cursor` is a
 *  stable per-event id (scanEventsSince's incremental cursoring compares it); `timestamp`
 *  is ISO, normalized to ms so `n(e.timestampMs)` reads it exactly as the old JSON-RPC
 *  `timestampMs`. */
function toSuiEvent(edge: GqlEventEdge): SuiEvent {
  const node = edge.node ?? {};
  const ms = node.timestamp ? Date.parse(node.timestamp) : NaN;
  return {
    type: node.contents?.type?.repr,
    timestampMs: Number.isFinite(ms) ? ms : undefined,
    parsedJson: node.contents?.json ?? undefined,
    id: { txDigest: edge.cursor ?? '', eventSeq: '' },
  };
}

/** One event page (newest-first), starting from `cursor` (null = newest), via the
 *  GraphQL `events` connection. Keeps the JSON-RPC-era signature so every caller is
 *  unchanged. GraphQL pages BACKWARD with `last`/`before`; `nextCursor` is the page's
 *  `startCursor` (its OLDEST edge) — passed straight back to page older. Edges arrive
 *  oldest->newest, so reverse to the newest-first order callers expect. */
async function queryEventsPage(filter: unknown, cursor: unknown, limit: number, opts?: GetOptions): Promise<EventPage> {
  const before = (cursor as string | null | undefined) ?? null;
  // GraphQL hard-caps a page at 50 and THROWS above it (the old JSON-RPC proxies
  // silently truncated), so clamp — callers wanting more history already page.
  const last = Math.min(Math.max(1, limit), 50);
  const res = await postEvents(
    JSON.stringify({ query: EVENTS_QUERY, variables: { filter: toEventFilter(filter), last, before } }),
    opts,
  );
  if (!res.ok) throw new PredictApiError(`events query -> ${res.status}`, res.status, graphqlUrl());
  const json = (await res.json()) as GqlEventsResponse;
  if (json.errors?.length) throw new PredictApiError(json.errors[0]?.message ?? 'events query failed', 0, graphqlUrl());
  const conn = json.data?.events;
  const data = (conn?.edges ?? []).map(toSuiEvent).reverse(); // oldest->newest => newest-first
  return {
    data,
    nextCursor: conn?.pageInfo?.startCursor ?? null,
    hasNextPage: Boolean(conn?.pageInfo?.hasPreviousPage),
  };
}

/** Newest `limit` events in ONE page. The public proxies cap a page at 50, so
 *  callers that need more history must page (see `queryEventsPaged`). */
async function queryEvents(filter: unknown, limit: number, opts?: GetOptions): Promise<SuiEvent[]> {
  return (await queryEventsPage(filter, null, limit, opts)).data;
}

/** Page back (newest → older) until `total` events are gathered or the feed ends.
 *  The 50-per-page proxy cap means a dense feed (pyth is ~1 obs/sec) returns only
 *  ~50s of history in one page — this walks the cursor to restore a full window. */
async function queryEventsPaged(filter: unknown, total: number, opts?: GetOptions): Promise<SuiEvent[]> {
  const PAGE = 50;
  const out: SuiEvent[] = [];
  let cursor: unknown = null;
  for (let i = 0; out.length < total && i < Math.ceil(total / PAGE) + 1; i++) {
    const page = await queryEventsPage(filter, cursor, PAGE, opts);
    out.push(...page.data);
    if (!page.hasNextPage || !page.nextCursor || page.data.length === 0) break;
    cursor = page.nextCursor;
  }
  return out.slice(0, total);
}

/**
 * Page newest-first collecting only events NEWER than `sinceCursor` (an event-id from
 * a prior scan), stopping at that event, the page budget, or the feed end. The
 * incremental primitive behind the leaderboard indexer: each cycle pulls just the gap
 * since last time, so the persisted tally accumulates completely no matter how much
 * total volume floods the stream. Returns the new events (newest-first) and the cursor
 * to store for next time (the newest event seen, or `sinceCursor` when nothing is new).
 */
export async function scanEventsSince(
  filter: unknown,
  sinceCursor: string | null,
  maxPages: number,
  opts?: GetOptions,
): Promise<{ events: SuiEvent[]; cursor: string | null }> {
  const collected: SuiEvent[] = [];
  let pageCursor: unknown = null;
  let newest: string | null = null;
  let caughtUp = false;
  for (let i = 0; i < maxPages && !caughtUp; i++) {
    const page = await queryEventsPage(filter, pageCursor, 50, opts);
    if (page.data.length === 0) break;
    if (newest === null) newest = eventId(page.data[0]);
    for (const e of page.data) {
      if (sinceCursor && eventId(e) === sinceCursor) {
        caughtUp = true;
        break;
      }
      collected.push(e);
    }
    if (!page.hasNextPage || !page.nextCursor) break;
    pageCursor = page.nextCursor;
  }
  return { events: collected, cursor: newest ?? sinceCursor };
}

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => String(v ?? '0');

/* -------------------------------- markets -------------------------------- */

function toMarket(e: SuiEvent): V2Market | null {
  const raw = e.parsedJson;
  if (!raw || typeof raw.expiry_market_id !== 'string') return null;
  // 8-21 dropped the leverage/liquidation knobs from MarketCreated; fill the no-op
  // defaults before reading so `toFloat` never sees undefined (see event-compat).
  const p = normalizeMarketCreated(raw);
  return {
    expiry_market_id: raw.expiry_market_id,
    pool_vault_id: s(p.pool_vault_id),
    propbook_underlying_id: n(p.propbook_underlying_id),
    expiry: n(p.expiry),
    checkpoint_timestamp_ms: n(e.timestampMs),
    tick_size: s(p.tick_size),
    admission_tick_size: s(p.admission_tick_size),
    max_expiry_allocation: s(p.max_expiry_allocation),
    initial_expiry_cash: s(p.initial_expiry_cash),
    liquidation_ltv: n(p.liquidation_ltv),
    max_admission_leverage: n(p.max_admission_leverage),
    backing_buffer_lambda: n(p.backing_buffer_lambda),
    base_fee: s(p.base_fee),
    min_fee: s(p.min_fee),
    min_entry_probability: s(p.min_entry_probability),
    max_entry_probability: s(p.max_entry_probability),
    expiry_fee_window_ms: n(p.expiry_fee_window_ms),
    expiry_fee_max_multiplier: n(p.expiry_fee_max_multiplier),
    trading_loss_rebate_rate: n(p.trading_loss_rebate_rate),
    kind: 'market_created',
  };
}

/** Newest-first `MarketCreated` rows — the drop-in for the beta `/markets`. The
 *  v2-discovery layer filters these to the active/tradeable set downstream. */
export async function onchainMarkets(limit = 100, opts?: GetOptions): Promise<V2Market[]> {
  const evs = await queryEvents(
    { MoveEventType: `${predictV2Config.packages.predict}::config_events::MarketCreated` },
    limit,
    opts,
  );
  return evs.map(toMarket).filter((m): m is V2Market => m !== null);
}

/* ------------------------------- pyth spot ------------------------------- */

function toObservation(e: SuiEvent): PythObservation | null {
  const obs = (e.parsedJson?.observation ?? null) as Record<string, unknown> | null;
  const v = (obs?.value ?? null) as Record<string, unknown> | null;
  if (!v || v.price_magnitude == null) return null;
  return {
    propbook_oracle_id: s(e.parsedJson?.propbook_oracle_id),
    pyth_source_id: n(v.pyth_source_id),
    price_magnitude: s(v.price_magnitude),
    price_is_negative: Boolean(v.price_is_negative),
    exponent_magnitude: n(v.exponent_magnitude),
    exponent_is_negative: Boolean(v.exponent_is_negative),
    source_timestamp_ms: n(obs?.source_timestamp_ms),
    checkpoint_timestamp_ms: n(e.timestampMs),
  };
}

/** Max pages to walk for the chart history. The 8-06 propbook feed publishes ~5
 *  observations/second (5× the old ~1/sec propbook HTTP feed), and each public proxy
 *  page is capped at 50 events (verified — a requested pageSize > 50 still returns
 *  50). So ~18 pages ≈ 900 raw events ≈ 180 distinct seconds (~3 min) — a
 *  legacy-length window. This budget bounds the walk so a dense feed can't balloon
 *  the page count; a sparse feed stops earlier once it has `limit` points. */
const PYTH_HISTORY_MAX_PAGES = 18;

/** Newest-first Pyth spot observations, DECIMATED to at most one per second as it
 *  pages. The price chart and the position sparklines both plot one point per second,
 *  so thinning here — instead of fetching 5× the events and discarding 4 of every 5
 *  downstream — keeps the payload lean and makes `limit` mean "seconds of history,"
 *  stable across the 6-24 (~1/sec) and 8-06 (~5/sec) feeds. Walks newest→older until
 *  it has `limit` per-second points, exhausts the page budget, or hits the feed end. */
export async function onchainPythObservations(limit = 300, opts?: GetOptions): Promise<PythObservation[]> {
  const filter = { MoveModule: { package: predictV2Config.packages.propbook, module: 'pyth_feed' } };
  const feedId = predictV2Config.asset.pythFeedId.toLowerCase();
  const PAGE = 50;
  const bySec = new Map<number, PythObservation>();
  let cursor: unknown = null;
  for (let i = 0; bySec.size < limit && i < PYTH_HISTORY_MAX_PAGES; i++) {
    const page = await queryEventsPage(filter, cursor, PAGE, opts);
    for (const e of page.data) {
      const o = toObservation(e);
      const ms = o?.source_timestamp_ms ?? o?.checkpoint_timestamp_ms ?? null;
      if (!o || ms == null) continue;
      // The event filter is MODULE-scoped, so it also carries any OTHER feed the
      // propbook writes through `pyth_feed` (8-06 folds the block-scholes value/svi
      // stores in here). Keep only THIS asset's feed — mixing two price series renders
      // as a square wave that jumps between them. Verified live: the BTC feed's
      // observations carry `propbook_oracle_id === asset.pythFeedId`. Guarded to a real
      // 0x… id so an id-format change can never blank the chart (absent/numeric ids are
      // kept, only a different real feed id is dropped).
      const oid = o.propbook_oracle_id;
      if (oid && oid.startsWith('0x') && oid.toLowerCase() !== feedId) continue;
      // Paging runs newest→older, so the FIRST observation seen in a second is that
      // second's latest tick — the value the chart keeps. Never overwrite it.
      const sec = Math.floor(ms / 1000);
      if (!bySec.has(sec)) bySec.set(sec, o);
    }
    if (!page.hasNextPage || !page.nextCursor || page.data.length === 0) break;
    cursor = page.nextCursor;
  }
  // Newest-first (descending seconds) — the order both callers already expect.
  return [...bySec.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, o]) => o);
}

/** Unwrap Sui's `{ type, fields }` move-struct JSON node down to its `fields`. */
const fieldsOf = (node: unknown): Record<string, unknown> => {
  const o = node as { fields?: Record<string, unknown> } | null;
  if (o && typeof o === 'object' && o.fields) return o.fields;
  return (node as Record<string, unknown>) ?? {};
};

/**
 * The LIVE latest Pyth spot, read straight off the `PythFeed` object's
 * `lane.latest` via gRPC `getObject` (json view) — fresh to the second, unlike the
 * event index which trails the chain ~20s. Same `PythObservation` shape as the
 * history feed so the top-price tape and chart live-edge match. Drives
 * `getPythLatest` on 7-29. The gRPC json is flat (no `{ type, fields }` wrapper),
 * which `fieldsOf` handles transparently — it returns the node itself when there's
 * no `.fields`, so the same navigation reads either shape.
 */
export async function onchainPythLatest(opts?: GetOptions): Promise<PythObservation | null> {
  const res = await grpcRead(
    (client, signal) =>
      client.core.getObjects({
        objectIds: [predictV2Config.asset.pythFeedId],
        include: { json: true },
        signal,
      }),
    { signal: opts?.signal },
  );
  // getObjects returns a per-object union (Object | Error). A missing/deleted feed
  // becomes null here (same as an empty content before); a transport failure still
  // throws out of getObjects, exactly like the old all-endpoints-failed path.
  const obj = res.objects[0];
  const content = fieldsOf(obj instanceof Error ? undefined : obj?.json);
  const latest = fieldsOf(fieldsOf(content.lane).latest);
  const value = fieldsOf(latest.value);
  if (value.price_magnitude == null) return null;
  return {
    propbook_oracle_id: '0',
    pyth_source_id: n(value.pyth_source_id),
    price_magnitude: s(value.price_magnitude),
    price_is_negative: Boolean(value.price_is_negative),
    exponent_magnitude: n(value.exponent_magnitude),
    exponent_is_negative: Boolean(value.exponent_is_negative),
    source_timestamp_ms: n(latest.source_timestamp_ms),
    checkpoint_timestamp_ms: oracleReadTimestamp(latest),
  };
}

/* --------------------- gRPC view getters (market state) ------------------- */

/**
 * gRPC reads here go through the SHARED failover reader ([[lib/sui/grpc]]), not a client
 * of their own.
 *
 * This file used to build its own client against a hardcoded `rpc-testnet.suiscan.xyz`,
 * left over from 2026-07-31 when the public testnet fullnode stalled and repointing was
 * the fix. On 2026-08-21 it happened in the opposite direction: suiscan returned Gateway
 * Timeout after 60s while the fullnode answered the identical read in 621ms. Because only
 * this file pointed at suiscan — and because it bypassed the failover layer that already
 * existed — the app half-broke. The chart, market list and odds stayed live, while the
 * nav price tape (`onchainPythLatest`) and every strike on the positions rail
 * (`onchainMarketState`) went blank, with no error and no timeout to react to.
 *
 * Both of those reads now get a 5s budget and an automatic retry on the next endpoint,
 * on the SERVER as well as in the browser — the failing route that day
 * (`/api/v2/pyth`) was server-side, where the browser-only health monitor never reached.
 */
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

interface SimResult {
  $kind?: string;
  commandResults?: { returnValues?: { bcs: Uint8Array }[] }[];
  FailedTransaction?: { status?: { error?: unknown } };
}

/** Run a read-only PTB and return [command][returnValue] BCS bytes. */
async function inspectReturns(tx: Transaction): Promise<Uint8Array[][]> {
  tx.setSender(ZERO);
  const res = (await grpcRead((client, signal) =>
    client.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
      checksEnabled: false,
      signal,
    }),
  )) as SimResult;
  if (res.$kind === 'FailedTransaction') {
    throw new PredictApiError(
      `inspect failed: ${JSON.stringify(res.FailedTransaction?.status?.error ?? {}).slice(0, 120)}`,
      0,
      // Whichever endpoint actually served this read, so an error names the node it came
      // from rather than a constant that may no longer be the one in use.
      activeGrpcUrl(),
    );
  }
  return (res.commandResults ?? []).map((c) => (c.returnValues ?? []).map((r) => new Uint8Array(r.bcs)));
}

const u64LE = (b: Uint8Array): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
};
const optU64 = (b: Uint8Array): bigint | null => ((b[0] ?? 0) === 0 ? null : u64LE(b.subarray(1)));
/** `Option<ID>`: a 0 tag means none, a 1 tag is followed by the 32-byte address. Returns
 *  null for a short/empty buffer too, so a missing return value reads as "no market"
 *  rather than as the zero address, which is a real id shape. */
const optAddress = (b: Uint8Array): string | null => {
  if ((b[0] ?? 0) === 0 || b.length < 33) return null;
  return '0x' + [...b.subarray(1, 33)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
const boolAt = (b: Uint8Array): boolean => (b[0] ?? 0) !== 0;

// Config fields that have no per-market getter — uniform protocol/template
// constants (deployment.testnet.json futureMarketTemplate). max_expiry_allocation
// varies by cadence but no consumer of getV2MarketState reads it, so a default is
// fine here (the bulk /markets list carries the exact per-cadence value).
const TEMPLATE = {
  base_fee: '20000000',
  min_fee: '5000000',
  min_entry_probability: '10000000',
  max_entry_probability: '990000000',
  max_expiry_allocation: '50000000000',
  initial_expiry_cash: '10000000000',
} as const;

/**
 * The view getters this state read simulates, in call order.
 *
 * 8-21 deleted `max_admission_leverage`, `liquidation_ltv` and `trading_loss_rebate_rate`
 * along with leverage itself. A PTB naming a function that does not exist fails to resolve,
 * so leaving them in does not misread three numbers, it makes the WHOLE read throw — and
 * this is the only path that can describe an EXPIRED market, so every settled position on
 * the rail would lose its strike.
 *
 * Results are looked up BY NAME below rather than by a hardcoded index, so dropping an entry
 * here cannot silently shift the remaining values (the previous version read
 * `liquidation_ltv` from slot 4 and `max_admission_leverage` from slot 3 — the exact kind of
 * off-by-one this republish would have introduced).
 */
const STATE_FNS: readonly string[] = [
  'expiry',
  'tick_size',
  'admission_tick_size',
  ...(V2_IS_821_PLUS ? [] : ['max_admission_leverage', 'liquidation_ltv']),
  'backing_buffer_lambda',
  'expiry_fee_window_ms',
  'expiry_fee_max_multiplier',
  ...(V2_IS_821_PLUS ? [] : ['trading_loss_rebate_rate']),
  'mint_paused',
  'reference_tick',
  'is_settled',
  'try_settlement_price',
];

/**
 * Full per-market state via on-chain view getters (works for EXPIRED markets a
 * position still references, which the bulk /markets list has dropped). Returns
 * the same V2MarketState shape as the beta indexer.
 */
export async function onchainMarketState(marketId: string): Promise<V2MarketState> {
  const pkg = predictV2Config.packages.predict;
  const tx = new Transaction();
  for (const fn of STATE_FNS) {
    tx.moveCall({ target: `${pkg}::expiry_market::${fn}`, arguments: [tx.object(marketId)] });
  }
  const cmds = await inspectReturns(tx);
  // By NAME, not by position: STATE_FNS differs per deployment, so an index would drift.
  const slot = (fn: string) => cmds[STATE_FNS.indexOf(fn)]?.[0] ?? new Uint8Array();
  const u64Of = (fn: string) => (STATE_FNS.includes(fn) ? Number(u64LE(slot(fn))) : 0);
  const market: V2Market = {
    expiry_market_id: marketId,
    pool_vault_id: predictV2Config.shared.poolVault,
    propbook_underlying_id: predictV2Config.asset.propbookUnderlyingId,
    expiry: u64Of('expiry'),
    checkpoint_timestamp_ms: 0, // creation time isn't a getter; unused by state consumers
    tick_size: u64LE(slot('tick_size')).toString(),
    admission_tick_size: u64LE(slot('admission_tick_size')).toString(),
    max_expiry_allocation: TEMPLATE.max_expiry_allocation,
    initial_expiry_cash: TEMPLATE.initial_expiry_cash,
    // Absent on 8-21 (no leverage, no liquidation). normalizeMarketCreated supplies the
    // no-op values the ticket and discovery layers expect, so nothing downstream sees NaN.
    ...(normalizeMarketCreated({
      liquidation_ltv: V2_IS_821_PLUS ? undefined : u64Of('liquidation_ltv'),
      max_admission_leverage: V2_IS_821_PLUS ? undefined : u64Of('max_admission_leverage'),
      trading_loss_rebate_rate: V2_IS_821_PLUS ? undefined : u64Of('trading_loss_rebate_rate'),
    }) as Pick<V2Market, 'liquidation_ltv' | 'max_admission_leverage' | 'trading_loss_rebate_rate'>),
    backing_buffer_lambda: u64Of('backing_buffer_lambda'),
    base_fee: TEMPLATE.base_fee,
    min_fee: TEMPLATE.min_fee,
    min_entry_probability: TEMPLATE.min_entry_probability,
    max_entry_probability: TEMPLATE.max_entry_probability,
    expiry_fee_window_ms: u64Of('expiry_fee_window_ms'),
    expiry_fee_max_multiplier: u64Of('expiry_fee_max_multiplier'),
    kind: 'market_created',
  };
  const referenceTick = optU64(slot('reference_tick'));
  const settlementPrice = boolAt(slot('is_settled')) ? optU64(slot('try_settlement_price')) : null;
  const settlement: V2Settlement | null =
    settlementPrice != null ? { settlement_price: settlementPrice.toString() } : null;
  return {
    expiry_market_id: marketId,
    market,
    reference_tick: referenceTick != null ? referenceTick.toString() : null,
    mint_paused: boolAt(slot('mint_paused')),
    settlement,
  };
}

/**
 * Live markets read from the REGISTRY instead of the event stream.
 *
 * WHY THIS EXISTS. `onchainMarkets` walks `MarketCreated` newest-first, which can only
 * ever surface markets created inside the walk window. That is fine for the short ladder
 * and structurally hopeless for the long one: a 1-day market is listed 48h before it
 * expires and a 1-week market 336h before, while 100 events reach back roughly 100
 * minutes and even the indexer's hard 500-row cap reaches 8.3 hours. The daily and weekly
 * markets 8-21 added were live and tradeable on chain the whole time; the board simply
 * had no way to find them, and got quieter the busier the venue was.
 *
 * `registry::expiry_market_id(&Registry, underlying, expiry) -> Option<ID>` turns
 * discovery around: instead of hunting for a creation event we ask for an expiry. Market
 * expiries are aligned to their cadence period from the epoch (verified against every
 * live market), so the candidate set is computable — a few per ladder — and the registry
 * answers whether each one exists. Cost is one simulate for the lookups plus one for the
 * details, no matter how much the venue is churning.
 */

/** How many periods past the next boundary to probe per ladder.
 *
 *  `windowSize` is how many markets the scheduler keeps open at once (2 on 8-21, 3
 *  before), and it is protocol config that can change without warning. Probing a couple
 *  extra costs nothing measurable — they are commands in a PTB that is already being
 *  sent — and a missing market is invisible in a way an extra `none` is not. */
const CADENCE_PROBE_SLACK = 2;

/** Config fields for a market discovered by expiry rather than by its creation event.
 *  Cadence-dependent values come from the deployment's own cadence table, which is where
 *  the scheduler reads them, so these are the real per-ladder numbers and not defaults. */
function cadenceTemplate(cadence: V2Cadence) {
  const row = predictV2Config.cadences.find((c) => c.name === cadence);
  return {
    max_expiry_allocation: row?.maxExpiryAllocation ?? TEMPLATE.max_expiry_allocation,
    initial_expiry_cash: row?.initialExpiryCash ?? TEMPLATE.initial_expiry_cash,
  };
}

/** The per-market getters the detail read calls, in order. Deliberately the small set
 *  discovery and the trade ticket need; the full state read stays `onchainMarketState`. */
const MARKET_FNS: readonly string[] = [
  'expiry',
  'tick_size',
  'admission_tick_size',
  'backing_buffer_lambda',
  'expiry_fee_window_ms',
  'expiry_fee_max_multiplier',
];

/**
 * Every market the registry currently lists, across all enabled cadences.
 *
 * Two round trips: probe candidate expiries, then read details for the ones that exist.
 * Returns [] on failure rather than throwing — this is a supplement to the event walk
 * (see getV2Markets), so a registry hiccup must degrade to the old behaviour instead of
 * emptying the board.
 */
let registryCache: { at: number; rows: V2Market[] } | null = null;

/**
 * How long a registry read stays good.
 *
 * The board polls every 4s to keep the 1-minute ladder from starving, but that pressure
 * is entirely on the EVENT walk, which is unchanged and still runs every poll. The
 * registry read exists for markets listed 48 hours to 14 days ahead, so re-probing it
 * four times a second buys nothing and costs two simulates each time. Worst case a market
 * nobody could have seen 30 seconds ago appears 30 seconds late.
 */
const REGISTRY_TTL_MS = 30_000;

export async function onchainRegistryMarkets(now: number = Date.now()): Promise<V2Market[]> {
  if (registryCache && now - registryCache.at < REGISTRY_TTL_MS) return registryCache.rows;
  const pkg = predictV2Config.packages.predict;
  const underlying = predictV2Config.asset.propbookUnderlyingId;

  // Candidate expiries, deduped ACROSS ladders. An expiry on a weekly boundary is also on
  // the daily and hourly ones, and it is one market, so probing it once is both cheaper
  // and the reason a market never appears twice in the result.
  const candidates = new Map<number, V2Cadence>();
  for (const c of predictV2Config.cadences) {
    const period = CADENCE_PERIOD_MS[c.name as V2Cadence];
    if (!period) continue;
    const count = Number(c.windowSize || 0) + CADENCE_PROBE_SLACK;
    const first = Math.ceil(now / period) * period;
    for (let k = 0; k < count; k++) candidates.set(first + k * period, c.name as V2Cadence);
  }
  const expiries = [...candidates.keys()].sort((a, b) => a - b);
  if (!expiries.length) return [];

  let found: { id: string; expiry: number }[];
  try {
    const probe = new Transaction();
    for (const expiry of expiries) {
      probe.moveCall({
        target: `${pkg}::registry::expiry_market_id`,
        arguments: [
          probe.object(predictV2Config.shared.registry),
          probe.pure.u32(underlying),
          probe.pure.u64(expiry),
        ],
      });
    }
    const hits = await inspectReturns(probe);
    found = expiries
      .map((expiry, i) => ({ expiry, id: optAddress(hits[i]?.[0] ?? new Uint8Array()) }))
      .filter((r): r is { expiry: number; id: string } => r.id !== null);
  } catch {
    return [];
  }
  if (!found.length) return [];

  try {
    const detail = new Transaction();
    for (const m of found) {
      for (const fn of MARKET_FNS) {
        detail.moveCall({ target: `${pkg}::expiry_market::${fn}`, arguments: [detail.object(m.id)] });
      }
    }
    const cmds = await inspectReturns(detail);
    const rows = found.map((m, mi) => {
      const at = (fn: string) => cmds[mi * MARKET_FNS.length + MARKET_FNS.indexOf(fn)]?.[0] ?? new Uint8Array();
      const u64Of = (fn: string) => Number(u64LE(at(fn)));
      const expiry = u64Of('expiry') || m.expiry;
      const tpl = cadenceTemplate(cadenceOf({ expiry } as V2Market));
      return {
        expiry_market_id: m.id,
        pool_vault_id: predictV2Config.shared.poolVault,
        propbook_underlying_id: underlying,
        expiry,
        // The listing time the scheduler used, reconstructed from the ladder rather than
        // observed. Nothing classifies on it any more (cadenceOf reads the expiry), but
        // dedupe and "newest first" sorts do, and a 0 here would rank every long market
        // last forever.
        checkpoint_timestamp_ms: expiry - windowSpanMs(cadenceOf({ expiry } as V2Market)),
        tick_size: u64LE(at('tick_size')).toString(),
        admission_tick_size: u64LE(at('admission_tick_size')).toString(),
        max_expiry_allocation: tpl.max_expiry_allocation,
        initial_expiry_cash: tpl.initial_expiry_cash,
        ...(normalizeMarketCreated({}) as Pick<
          V2Market,
          'liquidation_ltv' | 'max_admission_leverage' | 'trading_loss_rebate_rate'
        >),
        backing_buffer_lambda: u64Of('backing_buffer_lambda'),
        base_fee: TEMPLATE.base_fee,
        min_fee: TEMPLATE.min_fee,
        min_entry_probability: TEMPLATE.min_entry_probability,
        max_entry_probability: TEMPLATE.max_entry_probability,
        expiry_fee_window_ms: u64Of('expiry_fee_window_ms'),
        expiry_fee_max_multiplier: u64Of('expiry_fee_max_multiplier'),
        kind: 'market_created',
      } satisfies V2Market;
    });
    registryCache = { at: now, rows };
    return rows;
  } catch {
    // Do NOT cache a failure: the next poll should retry rather than serve an empty
    // board for 30 seconds because one simulate timed out.
    return [];
  }
}

/** How long before expiry the scheduler lists a market of this cadence. */
function windowSpanMs(cadence: V2Cadence): number {
  const row = predictV2Config.cadences.find((c) => c.name === cadence);
  return CADENCE_PERIOD_MS[cadence] * Math.max(1, Number(row?.windowSize || 1));
}

/* ------------------------------ account orders --------------------------- */

const ORDER_EVENTS: Record<string, string> = {
  OrderMinted: 'order_minted',
  LiveOrderRedeemed: 'live_order_redeemed',
  SettledOrderRedeemed: 'settled_order_redeemed',
  LiquidatedOrderRedeemed: 'liquidated_order_redeemed',
};

/**
 * Scan the newest N of each order-event type and keep the rows matching `match`,
 * merged newest-first. The event index can't filter by a struct field, so we
 * over-scan each type and filter client-side. On a low-volume testnet with short
 * market cadences (1m/5m/1h) that captures a market's or account's full lifecycle;
 * very old rows past the scan window fall off (the bounded-window property the beta
 * indexer's 500-cap also had). A complete account history would key by tx `Sender`.
 *
 * `deep` PAGES the cursor per type (up to `perType` raw rows) instead of taking a
 * single 50-row page. This matters for account/single-market history: mints and
 * redeems are SEPARATE event streams, so on a busy window a redeem's `OrderMinted`
 * can sit past the newest 50 mints — and without its mint a closed row loses its
 * cost basis, side and strike (PnL then reads as the full payout). Paging both
 * streams to the same depth keeps every redeem joined to its mint. Fan-outs across
 * many markets (the leaderboard) stay shallow (`deep=false`) to bound request count.
 */
async function scanOrderEvents(
  match: (p: Record<string, unknown>) => boolean,
  perType: number,
  opts?: GetOptions,
  deep = false,
): Promise<V2OrderEvent[]> {
  const pkg = predictV2Config.packages.predict;
  const types = Object.keys(ORDER_EVENTS);
  const scans = await Promise.all(
    types.map((evt) => {
      const filter = { MoveEventType: `${pkg}::order_events::${evt}` };
      return (deep ? queryEventsPaged(filter, perType, opts) : queryEvents(filter, perType, opts)).catch(
        () => [] as SuiEvent[],
      );
    }),
  );
  const rows: V2OrderEvent[] = [];
  types.forEach((evt, i) => {
    for (const e of scans[i]) {
      const p = e.parsedJson;
      if (!p || !match(p)) continue;
      const kind = ORDER_EVENTS[evt];
      rows.push({ ...normalizeOrderEvent(p as Record<string, unknown>, kind), kind, checkpoint_timestamp_ms: n(e.timestampMs) });
    }
  });
  rows.sort((a, b) => (b.checkpoint_timestamp_ms ?? 0) - (a.checkpoint_timestamp_ms ?? 0));
  return rows;
}

/**
 * An account's order EVENT log (mints + redeems), newest-first — the source the
 * portfolio/history/leaderboard fold from. Matched on `account_id`, which every
 * order event carries.
 */
export async function onchainAccountOrders(
  accountId: string,
  limit = 500,
  opts?: GetOptions,
): Promise<V2OrderEvent[]> {
  const want = accountId.toLowerCase();
  const perType = Math.min(500, Math.max(limit, 200));
  // Deep: page each stream so an account's mints and redeems are gathered over the
  // same window and stay joined (see scanOrderEvents) — portfolio, history and the
  // performance card all fold from this, so a truncated/mis-joined log corrupts them.
  const rows = await scanOrderEvents((p) => String(p.account_id).toLowerCase() === want, perType, opts, true);
  return rows.slice(0, limit);
}

/**
 * The account's OPEN positions (drop-in for `/accounts/{id}/positions`), folded
 * from its order log: net-open per `position_root_id` = Σ minted quantity − Σ
 * closed quantity. Each `OrderMinted` already carries every field the portfolio
 * normalizer reads (ticks, entry_probability, leverage, net_premium, order_id,
 * minted_at_ms), so an open position is just its mint with the open quantity and a
 * proportionally-scaled cost basis. Fully-closed roots are dropped; settled/closed
 * history comes from the order log itself (getAccountOrders).
 */
export async function onchainAccountPositions(
  accountId: string,
  opts?: GetOptions,
  guard?: ClosedRootsGuard,
): Promise<V2Position[]> {
  return foldOpenPositions(await onchainAccountOrders(accountId, 500, opts), guard);
}

/**
 * The SAME open-positions fold, but read by the account's OWNER wallet via the
 * whale-immune tx-sender path (onchainOwnerOrders). Use this whenever the owner is
 * known (the connected wallet, or a viewed trader profile): the account-id scan
 * loses a real account the moment a high-frequency bot buries it in the global
 * stream, whereas the sender filter always returns exactly this owner's trades.
 */
export async function onchainOwnerPositions(
  owner: string,
  opts?: GetOptions,
  guard?: ClosedRootsGuard,
): Promise<V2Position[]> {
  return foldOpenPositions(await onchainOwnerOrders(owner, 300, opts), guard);
}

/**
 * Net-open per `position_root_id` (Σ minted − Σ closed) → the still-open positions
 * (fully-closed roots dropped). Shared by the account-id and owner reads above.
 *
 * `guard` (optional, client-only) makes the fold flicker-proof against a redeem scan
 * that momentarily fails to see the keeper's closing redeem (see closed-roots-guard.ts):
 *  - a root that nets fully closed (mint present, remaining <= 0) is RECORDED closed;
 *  - a root that looks open but is already KNOWN closed is SUPPRESSED, not resurrected.
 * Passing no guard (server / tests) keeps the original behavior exactly.
 */
export function foldOpenPositions(orders: V2OrderEvent[], guard?: ClosedRootsGuard): V2Position[] {
  const terms = new Map<string, V2OrderEvent>(); // the mint (position terms)
  const minted = new Map<string, bigint>();
  const mintedPremium = new Map<string, bigint>();
  const closed = new Map<string, bigint>();
  const fullyClosed = new Set<string>(); // 8-21 settled claims — quantity-less, all-or-nothing
  for (const o of orders) {
    const root = String(o.position_root_id ?? o.order_id ?? '');
    if (!root) continue;
    if (o.kind === 'order_minted') {
      minted.set(root, (minted.get(root) ?? 0n) + big(o.quantity));
      mintedPremium.set(root, (mintedPremium.get(root) ?? 0n) + big(o.net_premium));
      if (!terms.has(root)) terms.set(root, o);
    } else if (isFullSettledClose(String(o.kind ?? ''), o.quantity_closed)) {
      // 8-21 made a settled claim all-or-nothing: SettledOrderRedeemed no longer carries a
      // quantity, because there is never a partial one. Without this the redeem subtracts 0
      // and the position stays "open" forever — a paid, settled bet that never leaves the
      // rail. Recorded as a root to close rather than subtracted here: this loop runs
      // NEWEST-FIRST, so the redeem is reached before its own mint and the minted total is
      // not known yet.
      fullyClosed.add(root);
    } else {
      closed.set(root, (closed.get(root) ?? 0n) + big(o.quantity_closed));
    }
  }
  const positions: V2Position[] = [];
  for (const [root, mint] of terms) {
    const totalMinted = minted.get(root) ?? 0n;
    const remaining = fullyClosed.has(root) ? 0n : totalMinted - (closed.get(root) ?? 0n);
    if (remaining <= 0n) {
      // Fully closed → not an open position. Record the CONFIRMED close (mint present)
      // so a later scan that fails to see this redeem can't resurrect the paid position.
      if (totalMinted > 0n) guard?.markClosed(root);
      continue;
    }
    // Looks open, but if we already saw it fully closed, this is a redeem-scan miss —
    // suppress the resurrection instead of flashing a paid position back as claimable.
    if (guard?.isClosed(root)) continue;
    // Cost basis of the still-open portion (proportional to what remains).
    const premium = totalMinted > 0n ? (mintedPremium.get(root)! * remaining) / totalMinted : 0n;
    positions.push({
      expiry_market_id: String(mint.expiry_market_id ?? ''),
      order_id: mint.order_id,
      position_root_id: root,
      lower_tick: mint.lower_tick,
      higher_tick: mint.higher_tick,
      open_quantity: remaining.toString(),
      quantity: totalMinted.toString(),
      net_premium: premium.toString(),
      entry_probability: mint.entry_probability,
      leverage: mint.leverage,
      opened_at_ms: n(mint.minted_at_ms ?? mint.checkpoint_timestamp_ms),
    } as V2Position);
  }
  return positions;
}

/**
 * The GLOBAL order-event stream (every market + every account), newest-first — the
 * drop-in for the legacy indexer's global mint/redeem feeds that the leaderboard
 * folds by owner. 7-29's chain event index serves the WHOLE stream, so the board
 * needs ONE paged scan per type here, not the 6-24 per-market fan-out (which on
 * 7-29 would re-query the same global newest-page once per market). `perType` caps
 * how far back each type pages; the walk stops early when the feed ends, so on a
 * quiet testnet this is a handful of pages, not the full cap.
 */
export async function onchainAllOrders(perType = 800, opts?: GetOptions): Promise<V2OrderEvent[]> {
  return scanOrderEvents(() => true, perType, opts, true);
}

/** Per-order-event-type cursors (struct name → last-seen event id). */
export type OrderCursors = Record<string, string | null>;

/**
 * Incrementally scan every order-event type since its stored cursor, returning the NEW
 * events (mapped to V2OrderEvent) and the advanced cursors. The leaderboard indexer
 * calls this each cycle and folds the result into KV-persisted tallies, so no trade is
 * ever dropped — the opposite of a windowed re-scan. `maxPagesPerType` bounds a single
 * catch-up (a long idle gap under heavy flood is rare and self-heals next cycle).
 */
export async function scanOrderEventsSince(
  cursors: OrderCursors,
  maxPagesPerType = 40,
  opts?: GetOptions,
): Promise<{ events: V2OrderEvent[]; cursors: OrderCursors }> {
  const pkg = predictV2Config.packages.predict;
  const types = Object.keys(ORDER_EVENTS);
  const results = await Promise.all(
    types.map((evt) =>
      scanEventsSince(
        { MoveEventType: `${pkg}::order_events::${evt}` },
        cursors[evt] ?? null,
        maxPagesPerType,
        opts,
      ).catch(() => ({ events: [] as SuiEvent[], cursor: cursors[evt] ?? null })),
    ),
  );
  const events: V2OrderEvent[] = [];
  const next: OrderCursors = { ...cursors };
  types.forEach((evt, i) => {
    for (const e of results[i].events) {
      const p = e.parsedJson;
      if (!p) continue;
      const kind = ORDER_EVENTS[evt];
      events.push({ ...normalizeOrderEvent(p as Record<string, unknown>, kind), kind, checkpoint_timestamp_ms: n(e.timestampMs) });
    }
    next[evt] = results[i].cursor;
  });
  return { events, cursors: next };
}

/**
 * Distinct owner addresses that have attached OUR BuilderCode, from the
 * `builder_code_events::BuilderCodeSet` stream (kept when `builder_code_id === codeId`).
 * That event fires only when an account opts into a code, so this stream is TINY and
 * whale-proof: it's the app's own user set, not the whole venue. The robust seed for
 * the Skew board (see fetchSkewLeaderboardRows) and the leaderboard's app-user fold.
 */
export async function onchainSkewOwners(codeId: string, opts?: GetOptions): Promise<string[]> {
  if (!codeId) return [];
  const evs = await queryEventsPaged(
    { MoveEventType: `${predictV2Config.packages.predict}::builder_code_events::BuilderCodeSet` },
    300,
    opts,
  );
  const owners = new Set<string>();
  for (const e of evs) {
    const p = e.parsedJson;
    if (p && String(p.builder_code_id) === codeId && p.owner) owners.add(String(p.owner));
  }
  return [...owners];
}

/**
 * Builder-fee CLAIM history for a code, from the `builder_code_events::BuilderFeesClaimed`
 * stream (kept when `builder_code_id === codeId`). Each event carries the swept `amount`
 * (DUSDC base units) and its tx timestamp — the on-chain source for the admin panel's
 * claimed-to-date, lifetime, chart, and recent-claims. Only the code OWNER can claim, so
 * this stream is TINY and reaches back fully in a few pages. Newest-first. Verified live
 * 2026-08-09 against a real claim tx: `{amount, builder_code_id, owner}`, ts from the event.
 */
export async function onchainBuilderCodeFees(codeId: string, limit = 200, opts?: GetOptions): Promise<V2BuilderFee[]> {
  if (!codeId) return [];
  const evs = await queryEventsPaged(
    { MoveEventType: `${predictV2Config.packages.predict}::builder_code_events::BuilderFeesClaimed` },
    Math.max(limit, 100),
    opts,
  );
  const want = codeId.toLowerCase();
  const rows: V2BuilderFee[] = [];
  for (const e of evs) {
    const p = e.parsedJson;
    if (!p || String(p.builder_code_id).toLowerCase() !== want) continue;
    rows.push({
      builder_code_id: String(p.builder_code_id),
      amount: String(p.amount ?? '0'),
      checkpoint_timestamp_ms: n(e.timestampMs),
    });
  }
  return rows.sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms).slice(0, limit);
}

/** One accrued builder-fee event: a trade's `builder_fee` (float DUSDC) at its time. */
export interface BuilderFeeAccrualEvent {
  ts: number;
  fee: number;
  /** Stake (net_premium, DUSDC) on a MINT — 0 on closes. The basis for the PROJECTED Skew
   *  fee (a % of each bet placed through Skew): summed over a window it's the trading volume
   *  the fee would apply to. Every mint carries a builder fee (min_fee > 0), so it rides the
   *  same fee>0 filter with no volume lost. */
  stake: number;
}

/**
 * Per-trade builder-fee ACCRUAL timeline for a code — every attributed trade's
 * `builder_fee`, timestamped. The CLAIM log (onchainBuilderCodeFees) only has the few
 * sweep events, so a cumulative chart of it draws a straight ramp that lies about the
 * cadence; this is the real earning curve: flat while the book is quiet, steep when
 * it's busy. Reconstructed from the code's attributed accounts (onchainSkewOwners) and
 * their order events (onchainOwnerOrders) — each order event already carries the exact
 * `builder_fee` charged (6-dec base), the `builder_code_id` that fee was paid to, and its
 * own mint/redeem timestamp, so no fee-rate assumption is needed. We only count fees whose
 * event `builder_code_id` is OURS (an account can re-attach to a different code over time,
 * so owner attribution alone isn't exact). Fees land on opens AND early closes; we take
 * every matching event with a positive fee. Ascending by time. The set of attributed
 * accounts is the app's own user list (tiny + whale-proof), so this stays cheap; still,
 * callers should cache it.
 */
export async function onchainBuilderFeeAccrual(
  codeId: string,
  opts?: GetOptions,
): Promise<BuilderFeeAccrualEvent[]> {
  if (!codeId) return [];
  const owners = await onchainSkewOwners(codeId, opts).catch(() => [] as string[]);
  if (owners.length === 0) return [];

  const perOwner = await Promise.all(
    owners.map((o) => onchainOwnerOrders(o, 300, opts).catch(() => [] as V2OrderEvent[])),
  );

  const want = codeId.toLowerCase();
  const out: BuilderFeeAccrualEvent[] = [];
  for (const orders of perOwner) {
    for (const e of orders) {
      const evCode = String((e as { builder_code_id?: unknown }).builder_code_id ?? '').toLowerCase();
      if (evCode !== want) continue;
      const fee = fromQuote(e.builder_fee ?? 0);
      const ts = e.checkpoint_timestamp_ms ?? 0;
      // Stake volume comes from the MINT (net_premium = the trader's bet); a close adds a
      // builder fee but no new volume, so its stake is 0.
      const stake = e.kind === 'order_minted' ? fromQuote(Number(e.net_premium ?? 0)) : 0;
      if (fee > 0 && ts > 0) out.push({ ts, fee, stake });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}


/** The `order_events` struct name in a fully-qualified event type IF it's from OUR
 *  predict package and one we fold on, else null. */
function orderStructOf(type: string | undefined): keyof typeof ORDER_EVENTS | null {
  if (!type) return null;
  const m = type.match(/^(.+)::order_events::(\w+)$/);
  if (!m || m[1] !== predictV2Config.packages.predict) return null;
  return (m[2] in ORDER_EVENTS ? m[2] : null) as keyof typeof ORDER_EVENTS | null;
}

/**
 * One owner's order log, read by TRANSACTION SENDER (the GraphQL `events` `sender`
 * filter) rather than by scanning the global event stream. This is the key to
 * surviving a high-frequency bot: the index filters by the owner server-side, so we get
 * exactly their events no matter how many other
 * accounts trade — unlike the account-id scan, which filters the whale-dominated
 * stream client-side and loses an account once it's buried. Newest-first; timestamps
 * come from each event's own `minted_at_ms` / `redeemed_at_ms`.
 */
export async function onchainOwnerOrders(owner: string, maxTx = 200, opts?: GetOptions): Promise<V2OrderEvent[]> {
  // ALSO scan the account's delegated-session keys (active AND retired, ANY device). A
  // session trade is sent by that ephemeral key, NOT the wallet owner, so an owner-only
  // scan misses every session trade and those positions never surface in the portfolio /
  // history — and they must stay visible even after the session is ENDED (the key is
  // forgotten, but the positions are still the owner's to claim). We discover the keys
  // three ways and union them:
  const ownerScan = await scanSenderOrders(owner, maxTx, opts);
  const ownerLc = owner.toLowerCase();
  const found = new Map<string, string>(); // lowercased -> original casing
  const add = (a?: string) => {
    if (!a) return;
    const lc = a.toLowerCase();
    if (lc !== ownerLc && !found.has(lc)) found.set(lc, a);
  };
  // (1) LOCAL: keys this device has used (incl. one just authorized but not yet indexed).
  for (const a of await loadSessionAddresses(owner)) add(a);
  // (2) PIGGYBACK: authorize_session is owner-signed, so the owner's OWN txs (already
  //     scanned above) carry the SessionAuthorized events — keys from ANY device, free.
  for (const au of ownerScan.auths) add(au.session);
  // (3) BACKSTOP: a dedicated SessionAuthorized event scan reaches back past BOTH the
  //     owner's trade-diluted tx window AND the 6-entry local list, so an OLD or ENDED
  //     session (whose authorize scrolled out of the window and was evicted from the
  //     local list) is still found — otherwise that session's trades/claims fold into
  //     neither positions nor history, leaving already-claimed positions stuck as
  //     "claimable". The account id comes from a piggyback authorization when present,
  //     else from the owner's OWN order events, so this runs even when the recent window
  //     holds no authorize. The event TYPE (type-origin, upgrade-safe) is the piggyback's,
  //     else one learned from any prior piggyback this session, else the config origin.
  const piggy = ownerScan.auths.find((a) => a.accountId && a.type);
  const acctId = piggy?.accountId ?? ownerScan.orders.find((o) => o.account_id)?.account_id;
  const authType = piggy?.type ?? learnedSessionAuthType ?? sessionAuthorizedType();
  if (acctId && authType) {
    for (const a of await discoverAccountSessionKeys(String(acctId), authType, opts)) add(a);
  }

  const sessionAddrs = [...found.values()];
  const desc = (a: V2OrderEvent, b: V2OrderEvent) => (b.checkpoint_timestamp_ms ?? 0) - (a.checkpoint_timestamp_ms ?? 0);
  const sessionScans = sessionAddrs.length
    ? await Promise.all(sessionAddrs.map((s) => scanSenderOrders(s, maxTx, opts)))
    : [];
  // Order events carry the account_id and are disjoint across senders (each lives in one
  // tx), so a plain union is correct; the fold nets open/close by position, any signer.
  const union = [ownerScan.orders, ...sessionScans.map((s) => s.orders)].flat();
  // (4) KEEPER REDEEMS. The sender scan above cannot see the protocol keeper's PERMISSIONLESS
  //     auto-redeem of a settled position (`redeem_settled_permissionless` is signed by the
  //     keeper, not the owner or a session key, and it deposits any payout into the owner's
  //     account). Without them an already-paid WIN lingers as "open" with a Claim that aborts
  //     (it's already closed), and a cleared LOSS lingers the same way — the read gap that
  //     order_value can't close, because on a settled market order_value returns the intrinsic
  //     payout (a paid winner still reads > 0), not the redeemed state. For each market that
  //     still looks open, scan THAT market's own tx log (server-side affectedObject filter,
  //     immune to the global stream's keeper-batch burial) and fold in every redeem for one of
  //     OUR open roots. Redeems dedupe by content so a self-signed redeem already present isn't
  //     counted twice. Scan EVERY open market (cap is a sanity bound, not the real limit); each
  //     per-market scan stops as soon as its open roots are accounted for, so a settled market
  //     costs ~1 page (the keeper's batch redeems are the market's newest txs).
  const byMarket = openRootsByMarket(union);
  // Scan OLDEST-open-position markets FIRST. A long-settled market is where the keeper's
  // redeem is waiting to be folded, and an old position still "open" is almost always already
  // keeper-paid (a fake-open piling up); a brand-new position is more likely genuinely live
  // with nothing to fold. Prioritising the old ones means a paid win like 0x9b12… (an old,
  // SESSION-minted market that sorts AFTER the owner's markets in insertion order) is scanned
  // within the cap instead of being sliced off the end — which is what left it stuck on
  // "Claim". This also breaks the compounding pile-up: fold the settled backlog first and the
  // net-open market count shrinks each poll until it clears. See [[keeper-redeem-read-gap]].
  const oldestMintMs = new Map<string, number>();
  for (const o of union) {
    if (o.kind !== 'order_minted' || !o.expiry_market_id) continue;
    const m = String(o.expiry_market_id);
    const t = n(o.minted_at_ms ?? o.checkpoint_timestamp_ms);
    const cur = oldestMintMs.get(m);
    if (cur === undefined || t < cur) oldestMintMs.set(m, t);
  }
  const markets = [...byMarket.keys()]
    .sort((a, b) => (oldestMintMs.get(a) ?? Infinity) - (oldestMintMs.get(b) ?? Infinity))
    .slice(0, KEEPER_SCAN_MARKET_CAP);
  if (markets.length) {
    const have = new Set(union.filter((o) => o.kind !== 'order_minted').map(redeemKey));
    // Bounded fan-out (not Promise.all): a heavy wallet + active session otherwise bursts
    // hundreds of requests and 429s, silently dropping a market's redeem (the "still Claim" bug).
    const extra = await mapLimit(markets, KEEPER_SCAN_CONCURRENCY, (m) => scanMarketRedeems(m, byMarket.get(m)!, opts));
    for (const r of extra.flat()) if (!have.has(redeemKey(r))) union.push(r);
  }
  return union.sort(desc);
}

/** Content key for a redeem event, stable across capture methods (sender scan vs per-market
 *  scan) so the two sources dedupe: a position closes once per (root, amount, time).
 *  Exported for unit tests. */
export function redeemKey(o: V2OrderEvent): string {
  const root = o.position_root_id ?? o.order_id ?? '';
  const ts = o.redeemed_at_ms ?? o.checkpoint_timestamp_ms ?? '';
  return `${root}:${o.quantity_closed ?? ''}:${String(ts)}`;
}

/** Sanity bound on how many markets get a per-market keeper-redeem scan per read. Each scan
 *  is cheap (early-break, ~1 page for a settled market) and now runs at bounded concurrency,
 *  so this can be generous — it just guards against a pathological open-position count. Raised
 *  from 50: a heavy session-trader's fake-open backlog (keeper-paid positions not yet folded)
 *  can exceed 50 net-open markets, and the OLD ones (a long-settled win like 0x9b12…) are
 *  exactly the keeper redeems we must fold — capping at 50 stranded them past the limit. */
const KEEPER_SCAN_MARKET_CAP = 150;

/** How many per-market redeem scans run at once. The scan fans out over every open market, so
 *  an unbounded Promise.all on a heavy wallet (many markets × up to 3 pages, ×3 with an active
 *  session's extra sender scans) bursts hundreds of requests at the GraphQL proxy and 429s —
 *  and a 429'd scan silently drops that market's keeper redeem, leaving a paid win stuck on
 *  "Claim". Bounding the fan-out keeps peak in-flight small so each scan actually lands. */
const KEEPER_SCAN_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `limit` in flight at once, preserving input order. A
 *  tiny bounded-concurrency map (no dep) for the keeper-redeem fan-out. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every market with a still-open position for this account (Σ minted > Σ closed per root),
 *  each mapped to its set of still-open roots. The markets are the targets for a per-market
 *  keeper-redeem scan; the roots let each scan STOP as soon as it has found their redeems
 *  (so a settled market costs ~1 page). Exported for unit tests. */
export function openRootsByMarket(orders: V2OrderEvent[]): Map<string, Set<string>> {
  const minted = new Map<string, bigint>();
  const closed = new Map<string, bigint>();
  const market = new Map<string, string>();
  for (const o of orders) {
    const root = String(o.position_root_id ?? o.order_id ?? '');
    if (!root) continue;
    if (o.kind === 'order_minted') {
      minted.set(root, (minted.get(root) ?? 0n) + big(o.quantity));
      if (o.expiry_market_id) market.set(root, String(o.expiry_market_id));
    } else {
      closed.set(root, (closed.get(root) ?? 0n) + big(o.quantity_closed));
    }
  }
  const byMarket = new Map<string, Set<string>>();
  for (const [root, m] of minted) {
    if (m - (closed.get(root) ?? 0n) > 0n && market.has(root)) {
      const mk = market.get(root)!;
      let set = byMarket.get(mk);
      if (!set) byMarket.set(mk, (set = new Set<string>()));
      set.add(root);
    }
  }
  return byMarket;
}

/** Distinct markets that still show a net-open position in `orders`. Exported for unit tests. */
export function openMarketsIn(orders: V2OrderEvent[]): string[] {
  return [...openRootsByMarket(orders).keys()];
}

const TX_EVENTS_QUERY = `query TxEvents($filter: TransactionFilter!, $last: Int!, $before: String) {
  transactions(last: $last, before: $before, filter: $filter) {
    pageInfo { hasPreviousPage startCursor }
    edges { node { effects { events { nodes { contents { type { repr } json } } } } } }
  }
}`;

interface GqlTxEdge {
  node?: {
    effects?: {
      events?: {
        nodes?: { contents?: { type?: { repr?: string } | null; json?: Record<string, unknown> | null } | null }[];
      } | null;
    } | null;
  };
}
interface GqlTxResponse {
  data?: {
    transactions?: { pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null }; edges?: GqlTxEdge[] };
  };
  errors?: { message?: string }[];
}

/** One page (newest-first) of a TRANSACTION-scoped event scan: the txs matching `filter`
 *  (e.g. `affectedObject` = a market object), flattened to the Move events they emitted.
 *  This is the one read the event index can't do — GraphQL `EventFilter` has no object
 *  predicate — so it stays on the transactions connection. Same `EventPage` shape as
 *  queryEventsPage; `nextCursor` is the page's oldest-edge cursor, passed back to page older. */
async function queryTxEventsPage(
  filter: { affectedObject?: string; sentAddress?: string },
  cursor: unknown,
  limit: number,
  opts?: GetOptions,
): Promise<EventPage> {
  const before = (cursor as string | null | undefined) ?? null;
  const last = Math.min(Math.max(1, limit), 50);
  // Route through postEvents (429/503 retry + backoff), NOT a raw fetch — this is
  // the keeper-redeem scan's page fetch, and on a window-refocus refetch burst the
  // public GraphQL proxy 429s. A raw fetch would throw, the caller's `.catch`
  // swallows it to "no redeems", and every already-paid position resurrects as
  // "paying out" for a few seconds until the next poll. Retrying keeps the fold
  // correct so paid positions stay closed. See [[keeper-redeem-read-gap]].
  const res = await postEvents(
    JSON.stringify({ query: TX_EVENTS_QUERY, variables: { filter, last, before } }),
    opts,
  );
  if (!res.ok) throw new PredictApiError(`tx query -> ${res.status}`, res.status, graphqlUrl());
  const json = (await res.json()) as GqlTxResponse;
  if (json.errors?.length) throw new PredictApiError(json.errors[0]?.message ?? 'tx query failed', 0, graphqlUrl());
  const conn = json.data?.transactions;
  const data: SuiEvent[] = [];
  // Edges arrive oldest->newest; reverse so callers see the newest txs first.
  for (const edge of (conn?.edges ?? []).slice().reverse()) {
    for (const evNode of edge.node?.effects?.events?.nodes ?? []) {
      data.push({ type: evNode.contents?.type?.repr, parsedJson: evNode.contents?.json ?? undefined });
    }
  }
  return { data, nextCursor: conn?.pageInfo?.startCursor ?? null, hasNextPage: Boolean(conn?.pageInfo?.hasPreviousPage) };
}

/** One market's redeem events for a set of OPEN ROOTS, read via the market object's OWN tx log
 *  (GraphQL `transactions` `affectedObject`). The server-side per-market filter is immune to
 *  the global event stream's keeper-batch burial, so it recovers the keeper's permissionless
 *  auto-redeem of a settled position (signed by the keeper, invisible to the owner/session
 *  sender scan). Matches by ROOT, not account_id: one WALLET can hold positions under several
 *  accounts (a fresh account per predict deployment), so a single-account filter stranded
 *  redeems under the wallet's other accounts (verified: market 0x9b12…, redeem under account
 *  0x00af33de, still showed "Claim"). `wantRoots` are exactly this owner's open roots in this
 *  market — globally-unique u256s — so a redeem whose root is one of them is unambiguously
 *  ours no matter which account (or the keeper) signed it. Newest-first, bounded — redeems are
 *  a market's last activity, right after settlement. */
async function scanMarketRedeems(
  marketId: string,
  wantRoots: Set<string>,
  opts?: GetOptions,
): Promise<V2OrderEvent[]> {
  const out: V2OrderEvent[] = [];
  // Stop as soon as every open root in this market has its redeem — a settled market's
  // keeper redeems are its newest txs, so this is usually satisfied on page 1. (A LIVE
  // market has no redeem, so `remaining` never empties and it just pages to the cap.)
  const remaining = new Set(wantRoots);
  let cursor: unknown = null;
  const PAGE = 50;
  for (let i = 0; i < 3; i++) {
    const page = await queryTxEventsPage({ affectedObject: marketId }, cursor, PAGE, opts).catch(
      () => ({ data: [] as SuiEvent[], nextCursor: null, hasNextPage: false }),
    );
    for (const ev of page.data) {
      const struct = orderStructOf(ev.type);
      if (!struct || struct === 'OrderMinted') continue; // redeems only
      const p = ev.parsedJson ?? {};
      const root = String(p.position_root_id ?? p.order_id ?? '');
      // Match the STABLE want-set (not `remaining`, which shrinks) so multiple partial
      // redeems of the same root are all captured; `remaining` only drives the early-break.
      if (!wantRoots.has(root)) continue; // one of OUR open roots in this market (any account)
      if (String(p.expiry_market_id ?? '') !== marketId) continue;
      const q = normalizeOrderEvent(p, ORDER_EVENTS[struct]);
      out.push({ ...q, kind: ORDER_EVENTS[struct], checkpoint_timestamp_ms: n(q.redeemed_at_ms ?? q.minted_at_ms) });
      remaining.delete(root);
    }
    if (remaining.size === 0) break; // every open root here is accounted for — stop early
    if (!page.hasNextPage || !page.nextCursor || page.data.length === 0) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** A session key authorized inside an owner-signed tx (the SessionAuthorized event). */
interface SessionAuth {
  session: string;
  accountId: string;
  /** The exact on-chain event type — learned here so the backstop scan is package-safe. */
  type: string;
}
interface SenderScan {
  orders: V2OrderEvent[];
  /** SessionAuthorized events found in these txs — non-empty only for the OWNER sender. */
  auths: SessionAuth[];
}

/** Match `<pkg>::sessions::SessionAuthorized` without pinning the package id (the sessions
 *  package was upgraded, so its published-at differs from the type-origin). */
const SESSION_AUTHORIZED_RE = /::sessions::SessionAuthorized$/;

/** The full SessionAuthorized event type, learned from the first piggyback authorization
 *  seen this session (upgrade-safe — it carries the real type-origin). Warms the
 *  by-account backstop even for an owner whose own tx window holds no authorize. */
let learnedSessionAuthType: string | null = null;

/** The SessionAuthorized event type built from the configured type-origin — the
 *  deterministic fallback when nothing has been learned yet. Null when sessions isn't
 *  deployed on this network. */
function sessionAuthorizedType(): string | null {
  const origin = predictV2Config.packages.sessionsEventOrigin;
  return origin ? `${origin}::sessions::SessionAuthorized` : null;
}

/** Scan ONE sender's events via the GraphQL `sender` filter (the whale-immune read),
 *  collecting its order events AND any SessionAuthorized events (which only appear for the
 *  owner, as authorize_session is owner-signed). Extracted so onchainOwnerOrders can fold in the
 *  account's delegated-session keys alongside the wallet owner. */
async function scanSenderOrders(sender: string, maxTx: number, opts?: GetOptions): Promise<SenderScan> {
  const orders: V2OrderEvent[] = [];
  const auths: SessionAuth[] = [];
  let cursor: unknown = null;
  const PAGE = 50;
  // Events emitted by the sender's OWN txs (GraphQL `sender` filter = the FromAddress
  // equivalent): the sender's order events PLUS the SessionAuthorized events its
  // owner-signed authorize txs emit. Whale-immune — filtered by sender server-side.
  for (let i = 0; orders.length < maxTx * 2 && i < Math.ceil(maxTx / PAGE) + 1; i++) {
    const page = await queryEventsPage({ Sender: sender }, cursor, PAGE, opts).catch(
      () => ({ data: [] as SuiEvent[], nextCursor: null, hasNextPage: false }),
    );
    for (const ev of page.data) {
      const struct = orderStructOf(ev.type);
      if (struct) {
        const p = ev.parsedJson ?? {};
        const q = normalizeOrderEvent(p, ORDER_EVENTS[struct]);
        orders.push({ ...q, kind: ORDER_EVENTS[struct], checkpoint_timestamp_ms: n(q.minted_at_ms ?? q.redeemed_at_ms) });
      } else if (ev.type && SESSION_AUTHORIZED_RE.test(ev.type)) {
        const p = ev.parsedJson ?? {};
        learnedSessionAuthType ??= ev.type; // warm the by-account backstop's type
        if (p.session) auths.push({ session: String(p.session), accountId: String(p.account_id ?? ''), type: ev.type });
      }
    }
    if (!page.hasNextPage || !page.nextCursor || page.data.length === 0) break;
    cursor = page.nextCursor;
  }
  return { orders, auths };
}

/** Every session key ever authorized for an account, from its SessionAuthorized events.
 *  These are RARE (≤20 live per account, a handful ever), so this reaches far back in a
 *  few pages — the device-independent discovery that also survives a revoke (the wrapper's
 *  live session table is pruned on revoke; the event log is append-only). Cached per
 *  account (authorizations almost never change) so it doesn't re-scan every 12s poll. */
const sessionKeyCache = new Map<string, { keys: string[]; at: number }>();
const SESSION_KEY_TTL_MS = 5 * 60_000;

async function discoverAccountSessionKeys(accountId: string, eventType: string, opts?: GetOptions): Promise<string[]> {
  const cached = sessionKeyCache.get(accountId);
  if (cached && Date.now() - cached.at < SESSION_KEY_TTL_MS) return cached.keys;
  const want = accountId.toLowerCase();
  const keys = new Set<string>();
  const events = await queryEventsPaged({ MoveEventType: eventType }, 300, opts).catch(() => [] as SuiEvent[]);
  for (const ev of events) {
    const p = ev.parsedJson ?? {};
    if (p.session && String(p.account_id ?? '').toLowerCase() === want) keys.add(String(p.session));
  }
  const out = [...keys];
  if (sessionKeyCache.size > 100) sessionKeyCache.clear(); // bound growth across many viewed profiles
  sessionKeyCache.set(accountId, { keys: out, at: Date.now() });
  return out;
}

/**
 * A market's order EVENT log (mints + redeems), newest-first — the per-market flow
 * feed (drop-in for the beta `/markets/:id/orders`). Matched on `expiry_market_id`.
 */
export async function onchainMarketOrders(
  marketId: string,
  limit = 60,
  opts?: GetOptions,
): Promise<V2OrderEvent[]> {
  const want = marketId.toLowerCase();
  const perType = Math.min(500, Math.max(limit, 120));
  const rows = await scanOrderEvents((p) => String(p.expiry_market_id).toLowerCase() === want, perType, opts);
  return rows.slice(0, limit);
}

const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0');
  } catch {
    return 0n;
  }
};

/**
 * Open interest for one market (drop-in for `/markets/:id/open-interest`), folded
 * from the market's order log: net-open per position = minted quantity − closed
 * quantity. `open_quantity` is the max payout at risk (each unit pays $1). Floor
 * shares have no read-only source on 7-29, so they report 0 — the risk panel's
 * primary exposure figure is open_quantity, exact within the scan window (short
 * market cadences keep a whole market's life in the window).
 */
const oiCache = new Map<string, { oi: V2OpenInterest; at: number }>();
const OI_CACHE_TTL_MS = 30_000;

export async function onchainMarketOpenInterest(
  marketId: string,
  opts?: GetOptions,
): Promise<V2OpenInterest> {
  const want = marketId.toLowerCase();
  // Cache per market (short TTL): the risk/analytics panels poll OI for EVERY active
  // market on a 15s interval, and each read deep-scans the order stream over the
  // rate-limited GraphQL event index — a fresh scan per poll per market would throttle.
  // The TTL bounds a market's real re-scan rate to ~30s while the UI still polls freely.
  const cached = oiCache.get(want);
  if (cached && Date.now() - cached.at < OI_CACHE_TTL_MS) return cached.oi;
  // One focused market, paged so a busy market's open set is counted (max payout at
  // risk / exposure). Depth is bounded: short market cadences (1m/5m/1h) keep a market's
  // whole life in a small window, so ~100 recent order events cover its open set.
  const rows = await scanOrderEvents((p) => String(p.expiry_market_id).toLowerCase() === want, 100, opts, true);
  const minted = new Map<string, bigint>();
  const closed = new Map<string, bigint>();
  for (const r of rows) {
    const root = String(r.position_root_id ?? r.order_id ?? '');
    if (!root) continue;
    if (r.kind === 'order_minted') minted.set(root, (minted.get(root) ?? 0n) + big(r.quantity));
    else closed.set(root, (closed.get(root) ?? 0n) + big(r.quantity_closed));
  }
  let open_order_count = 0;
  let openQty = 0n;
  for (const [root, m] of minted) {
    const rem = m - (closed.get(root) ?? 0n);
    if (rem > 0n) {
      open_order_count += 1;
      openQty += rem;
    }
  }
  const oi: V2OpenInterest = {
    expiry_market_id: marketId,
    open_order_count,
    open_quantity: openQty.toString(),
    open_floor_shares: '0',
  };
  if (oiCache.size > 200) oiCache.clear(); // bound growth across many viewed markets
  oiCache.set(want, { oi, at: Date.now() });
  return oi;
}

/* -------------------------------- vault ---------------------------------- */

/** Vault events are DEFINED in `vault_events` and EMITTED by the `plp` module;
 *  MoveEventType (by struct type) is the filter these proxies honor. */
const vaultEventType = (name: string) => `${predictV2Config.packages.predict}::vault_events::${name}`;

function toFlush(e: SuiEvent): V2VaultFlush | null {
  const p = e.parsedJson;
  if (!p) return null;
  return {
    checkpoint_timestamp_ms: n(e.timestampMs),
    epoch: n(p.epoch),
    pool_value: s(p.pool_value),
    total_supply: s(p.total_supply),
    active_market_nav: s(p.active_market_nav),
    market_count: n(p.market_count),
    supplies_filled: n(p.supplies_filled),
    withdrawals_filled: n(p.withdrawals_filled),
    requests_processed: n(p.requests_processed),
    idle_balance_after: s(p.idle_balance_after),
    total_supply_after: s(p.total_supply_after),
  };
}

/** Keeper flush history, newest-first (drop-in for `/vaults/:id/flushes`). Each
 *  FlushExecuted marks the pool: pool_value / total_supply is the NAV-per-share. */
export async function onchainVaultFlushes(limit = 200, opts?: GetOptions): Promise<V2VaultFlush[]> {
  const evs = await queryEvents({ MoveEventType: vaultEventType('FlushExecuted') }, limit, opts);
  return evs.map(toFlush).filter((f): f is V2VaultFlush => f !== null);
}

/** Realized profit per market settlement, newest-first (`/vaults/:id/profit`). */
export async function onchainVaultProfit(limit = 200, opts?: GetOptions): Promise<V2VaultProfit[]> {
  const evs = await queryEvents({ MoveEventType: vaultEventType('ExpiryProfitMaterialized') }, limit, opts);
  return evs
    .map((e): V2VaultProfit | null => {
      const p = e.parsedJson;
      if (!p) return null;
      return {
        checkpoint_timestamp_ms: n(e.timestampMs),
        expiry_market_id: s(p.expiry_market_id),
        lp_profit: s(p.lp_profit),
        protocol_profit: s(p.protocol_profit),
        profit_basis_after: s(p.profit_basis_after),
        // extra (allowed by index sig) — completes V2VaultCurrent in onchainVaultState
        protocol_reserve_balance_after: s(p.protocol_reserve_balance_after),
        pending_protocol_profit_after: s(p.pending_protocol_profit_after),
      };
    })
    .filter((x): x is V2VaultProfit => x !== null);
}

/** Executed LP deposits (DUSDC → PLP at flush), newest-first. */
export async function onchainVaultSupplyFills(limit = 30, opts?: GetOptions): Promise<V2VaultSupplyFill[]> {
  const evs = await queryEvents({ MoveEventType: vaultEventType('SupplyFilled') }, limit, opts);
  return evs
    .map((e): V2VaultSupplyFill | null => {
      const p = e.parsedJson;
      if (!p) return null;
      return {
        checkpoint_timestamp_ms: n(e.timestampMs),
        pool_vault_id: s(p.pool_vault_id),
        account_id: s(p.account_id),
        recipient: s(p.recipient),
        request_index: n(p.index),
        dusdc_amount: s(p.dusdc_amount),
        shares_minted: s(p.shares_minted),
        kind: 'supply_filled',
      };
    })
    .filter((x): x is V2VaultSupplyFill => x !== null);
}

/** Executed LP withdrawals (PLP → DUSDC at flush), newest-first. */
export async function onchainVaultWithdrawFills(limit = 30, opts?: GetOptions): Promise<V2VaultWithdrawFill[]> {
  const evs = await queryEvents({ MoveEventType: vaultEventType('WithdrawFilled') }, limit, opts);
  return evs
    .map((e): V2VaultWithdrawFill | null => {
      const p = e.parsedJson;
      if (!p) return null;
      return {
        checkpoint_timestamp_ms: n(e.timestampMs),
        pool_vault_id: s(p.pool_vault_id),
        account_id: s(p.account_id),
        recipient: s(p.recipient),
        request_index: n(p.index),
        shares_burned: s(p.shares_burned),
        dusdc_amount: s(p.dusdc_amount),
        kind: 'withdraw_filled',
      };
    })
    .filter((x): x is V2VaultWithdrawFill => x !== null);
}

/**
 * Vault NAV state (drop-in for `/vaults/:id/state`). Full pool value + latest flush
 * come from the newest FlushExecuted; reserve / profit-basis fields from the newest
 * ExpiryProfitMaterialized. If no flush is in the scan window both are null and the
 * caller falls back to the on-chain vault views (useVaultV2).
 */
export async function onchainVaultState(opts?: GetOptions): Promise<V2VaultServerState> {
  const poolVaultId = predictV2Config.shared.poolVault;
  const [flushes, profit] = await Promise.all([
    onchainVaultFlushes(1, opts).catch(() => [] as V2VaultFlush[]),
    onchainVaultProfit(1, opts).catch(() => [] as V2VaultProfit[]),
  ]);
  const flush = flushes[0] ?? null;
  const prof = profit[0] ?? null;
  const current: V2VaultCurrent | null = flush
    ? {
        idle_balance_after: s(flush.idle_balance_after),
        total_supply: s(flush.total_supply),
        pool_value: s(flush.pool_value),
        active_market_nav: s(flush.active_market_nav),
        protocol_reserve_balance_after: s(prof?.protocol_reserve_balance_after ?? '0'),
        pending_protocol_profit_after: s(prof?.pending_protocol_profit_after ?? '0'),
        profit_basis_after: s(prof?.profit_basis_after ?? '0'),
        fee_incentive_reserve_after: null,
      }
    : null;
  return { pool_vault_id: poolVaultId, current, latest_flush: flush };
}
