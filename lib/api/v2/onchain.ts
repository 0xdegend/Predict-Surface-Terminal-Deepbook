/**
 * lib/api/v2/onchain.ts — the on-chain read layer (7-29 and 8-06).
 *
 * These deployments have NO HTTP indexer, so these functions reconstruct the same
 * shapes the beta indexer returned (V2Market, PythObservation) directly from the
 * chain's own event index via `suix_queryEvents`. They are dispatched to from
 * client.ts when `V2_IS_729_PLUS` (7-29 / 8-06), behind the identical function
 * signatures and TanStack keys, so no consumer or UI changes.
 *
 * Pure functions (no React) — work from Server Components, queryFns, and scripts.
 * `suix_queryEvents` is the chain's index, served by CORS-friendly public JSON-RPC
 * proxies (Mysten's own fullnode has deprecated JSON-RPC). We try a primary + a
 * fallback so a single proxy hiccup doesn't blank the app.
 */
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { loadSessionAddresses } from '@/lib/sui/v2/session';
import { PredictApiError } from '@/lib/api/client';
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

/** Ordered JSON-RPC endpoints that serve `suix_queryEvents` with open CORS. */
const EVENT_RPCS: string[] = [
  process.env.NEXT_PUBLIC_SUI_EVENT_RPC || 'https://rpc-testnet.suiscan.xyz',
  'https://sui-testnet-rpc.publicnode.com',
];

// A browser sends its own UA; Node's default UA can trip the proxies' WAF, so set
// one server-side only (browsers forbid the header anyway).
const SERVER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface SuiEvent {
  type?: string;
  timestampMs?: string | number;
  parsedJson?: Record<string, unknown>;
  /** Stable event position, for incremental cursoring (see scanEventsSince). */
  id?: { txDigest?: string; eventSeq?: string };
}

/** A stable event-id string ("txDigest:eventSeq") for cursor comparison. */
const eventId = (e: SuiEvent): string => `${e.id?.txDigest ?? ''}:${e.id?.eventSeq ?? ''}`;

/** Resilient JSON-RPC call across the endpoint list (server-only UA; browser CORS-ok). */
async function rpcCall<T>(method: string, params: unknown[], opts?: GetOptions): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof window === 'undefined') headers['User-Agent'] = SERVER_UA;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  let lastErr: unknown;
  for (const url of EVENT_RPCS) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body, cache: 'no-store', signal: opts?.signal });
      if (!res.ok) throw new PredictApiError(`${method} → ${res.status}`, res.status, url);
      const j = (await res.json()) as { result?: T; error?: { message?: string } };
      if (j.error) throw new PredictApiError(j.error.message ?? `${method} error`, 0, url);
      return j.result as T;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${method}: all endpoints failed`);
}

interface EventPage {
  data: SuiEvent[];
  nextCursor: unknown;
  hasNextPage: boolean;
}

/** One `suix_queryEvents` page (descending), starting from `cursor` (null = newest). */
async function queryEventsPage(filter: unknown, cursor: unknown, limit: number, opts?: GetOptions): Promise<EventPage> {
  const r = await rpcCall<{ data?: SuiEvent[]; nextCursor?: unknown; hasNextPage?: boolean }>(
    'suix_queryEvents',
    [filter, cursor ?? null, limit, true],
    opts,
  );
  return { data: r?.data ?? [], nextCursor: r?.nextCursor ?? null, hasNextPage: Boolean(r?.hasNextPage) };
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
  const p = e.parsedJson;
  if (!p || typeof p.expiry_market_id !== 'string') return null;
  return {
    expiry_market_id: p.expiry_market_id,
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
 * `lane.latest` via `sui_getObject` — fresh to the second, unlike the event index
 * which trails the chain ~20s. Same `PythObservation` shape as the history feed so
 * the top-price tape and chart live-edge match. Drives `getPythLatest` on 7-29.
 */
export async function onchainPythLatest(opts?: GetOptions): Promise<PythObservation | null> {
  const res = await rpcCall<{ data?: { content?: unknown } }>(
    'sui_getObject',
    [predictV2Config.asset.pythFeedId, { showContent: true }],
    opts,
  );
  const content = fieldsOf(res?.data?.content);
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
    checkpoint_timestamp_ms: n(latest.update_timestamp_ms),
  };
}

/* --------------------- gRPC view getters (market state) ------------------- */

const GRPC_URL = process.env.NEXT_PUBLIC_SUI_GRPC_URL || 'https://rpc-testnet.suiscan.xyz';
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
let _grpc: SuiGrpcClient | null = null;
const grpc = (): SuiGrpcClient => (_grpc ??= new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_URL }));

interface SimResult {
  $kind?: string;
  commandResults?: { returnValues?: { bcs: Uint8Array }[] }[];
  FailedTransaction?: { status?: { error?: unknown } };
}

/** Run a read-only PTB and return [command][returnValue] BCS bytes. */
async function inspectReturns(tx: Transaction): Promise<Uint8Array[][]> {
  tx.setSender(ZERO);
  const res = (await grpc().simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as SimResult;
  if (res.$kind === 'FailedTransaction') {
    throw new PredictApiError(
      `inspect failed: ${JSON.stringify(res.FailedTransaction?.status?.error ?? {}).slice(0, 120)}`,
      0,
      GRPC_URL,
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

// Getter order: value getters (u64) then flags/options. Mirrors expiry_market.move.
const STATE_FNS = [
  'expiry', 'tick_size', 'admission_tick_size', 'max_admission_leverage',
  'liquidation_ltv', 'backing_buffer_lambda', 'expiry_fee_window_ms',
  'expiry_fee_max_multiplier', 'trading_loss_rebate_rate', // 0..8 = u64
  'mint_paused', 'reference_tick', 'is_settled', 'try_settlement_price', // 9..12
] as const;

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
  const at = (i: number) => cmds[i][0];
  const market: V2Market = {
    expiry_market_id: marketId,
    pool_vault_id: predictV2Config.shared.poolVault,
    propbook_underlying_id: predictV2Config.asset.propbookUnderlyingId,
    expiry: Number(u64LE(at(0))),
    checkpoint_timestamp_ms: 0, // creation time isn't a getter; unused by state consumers
    tick_size: u64LE(at(1)).toString(),
    admission_tick_size: u64LE(at(2)).toString(),
    max_expiry_allocation: TEMPLATE.max_expiry_allocation,
    initial_expiry_cash: TEMPLATE.initial_expiry_cash,
    liquidation_ltv: Number(u64LE(at(4))),
    max_admission_leverage: Number(u64LE(at(3))),
    backing_buffer_lambda: Number(u64LE(at(5))),
    base_fee: TEMPLATE.base_fee,
    min_fee: TEMPLATE.min_fee,
    min_entry_probability: TEMPLATE.min_entry_probability,
    max_entry_probability: TEMPLATE.max_entry_probability,
    expiry_fee_window_ms: Number(u64LE(at(6))),
    expiry_fee_max_multiplier: Number(u64LE(at(7))),
    trading_loss_rebate_rate: Number(u64LE(at(8))),
    kind: 'market_created',
  };
  const referenceTick = optU64(at(10));
  const settlementPrice = boolAt(at(11)) ? optU64(at(12)) : null;
  const settlement: V2Settlement | null =
    settlementPrice != null ? { settlement_price: settlementPrice.toString() } : null;
  return {
    expiry_market_id: marketId,
    market,
    reference_tick: referenceTick != null ? referenceTick.toString() : null,
    mint_paused: boolAt(at(9)),
    settlement,
  };
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
 * merged newest-first. `suix_queryEvents` can't filter by a struct field, so we
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
      rows.push({ ...(p as Record<string, unknown>), kind: ORDER_EVENTS[evt], checkpoint_timestamp_ms: n(e.timestampMs) });
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
export async function onchainAccountPositions(accountId: string, opts?: GetOptions): Promise<V2Position[]> {
  return foldOpenPositions(await onchainAccountOrders(accountId, 500, opts));
}

/**
 * The SAME open-positions fold, but read by the account's OWNER wallet via the
 * whale-immune tx-sender path (onchainOwnerOrders). Use this whenever the owner is
 * known (the connected wallet, or a viewed trader profile): the account-id scan
 * loses a real account the moment a high-frequency bot buries it in the global
 * stream, whereas the sender filter always returns exactly this owner's trades.
 */
export async function onchainOwnerPositions(owner: string, opts?: GetOptions): Promise<V2Position[]> {
  return foldOpenPositions(await onchainOwnerOrders(owner, 300, opts));
}

/** Net-open per `position_root_id` (Σ minted − Σ closed) → the still-open positions
 *  (fully-closed roots dropped). Shared by the account-id and owner reads above. */
function foldOpenPositions(orders: V2OrderEvent[]): V2Position[] {
  const terms = new Map<string, V2OrderEvent>(); // the mint (position terms)
  const minted = new Map<string, bigint>();
  const mintedPremium = new Map<string, bigint>();
  const closed = new Map<string, bigint>();
  for (const o of orders) {
    const root = String(o.position_root_id ?? o.order_id ?? '');
    if (!root) continue;
    if (o.kind === 'order_minted') {
      minted.set(root, (minted.get(root) ?? 0n) + big(o.quantity));
      mintedPremium.set(root, (mintedPremium.get(root) ?? 0n) + big(o.net_premium));
      if (!terms.has(root)) terms.set(root, o);
    } else {
      closed.set(root, (closed.get(root) ?? 0n) + big(o.quantity_closed));
    }
  }
  const positions: V2Position[] = [];
  for (const [root, mint] of terms) {
    const totalMinted = minted.get(root) ?? 0n;
    const remaining = totalMinted - (closed.get(root) ?? 0n);
    if (remaining <= 0n) continue; // fully closed → not an open position
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
      events.push({ ...(p as Record<string, unknown>), kind: ORDER_EVENTS[evt], checkpoint_timestamp_ms: n(e.timestampMs) });
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
      if (fee > 0 && ts > 0) out.push({ ts, fee });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

interface TxBlock {
  digest?: string;
  events?: { type?: string; parsedJson?: Record<string, unknown> }[];
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
 * One owner's order log, read by TRANSACTION SENDER (`suix_queryTransactionBlocks`
 * FromAddress) rather than by scanning the global event stream. This is the key to
 * surviving a high-frequency bot: the RPC filters by the owner server-side, so we get
 * exactly their txs (and the order events inside them) no matter how many other
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
  //     auto-redeem of settled winners (`redeem_settled_permissionless` is signed by the
  //     keeper, not the owner or a session key, and it deposits the payout into the owner's
  //     account). Without them an already-paid position lingers as "open" and its Redeem
  //     aborts because it's already closed. For each market that still looks open here, scan
  //     THAT market's own tx log (server-side InputObject filter, immune to the global
  //     stream's keeper-batch burial) for this account's redeems and fold them in. Redeems
  //     dedupe by content so a self-signed redeem already present isn't counted twice.
  const acct = acctId ?? union.find((o) => o.account_id)?.account_id;
  if (acct) {
    // Scan EVERY market with a still-open position for this account. This used to cap at
    // 12, which STRANDED keeper-claimed positions past the 12th open market: they never
    // got folded, so they piled up as fake "open" — which in turn pushed genuinely-open
    // markets further out of range, a compounding gap (a heavy session-trader would see
    // long-settled, already-paid wins stuck on "ready to redeem"). Each per-market scan
    // stops as soon as that market's open roots are accounted for, so a settled market
    // costs ~1 page (the keeper's batch redeems are the market's newest txs); the cap is
    // now just a sanity bound on total fan-out.
    const byMarket = openRootsByMarket(union);
    const markets = [...byMarket.keys()].slice(0, KEEPER_SCAN_MARKET_CAP);
    if (markets.length) {
      const have = new Set(union.filter((o) => o.kind !== 'order_minted').map(redeemKey));
      const extra = await Promise.all(markets.map((m) => scanMarketAccountRedeems(m, String(acct), byMarket.get(m)!, opts)));
      for (const r of extra.flat()) if (!have.has(redeemKey(r))) union.push(r);
    }
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
 *  is cheap (early-break, ~1 page for a settled market), so this can be generous — it just
 *  guards against a pathological account with a huge open-position count. */
const KEEPER_SCAN_MARKET_CAP = 50;

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

/** One market's redeem events for a given account, read via the market object's OWN tx log
 *  (`suix_queryTransactionBlocks` InputObject). The server-side per-market filter is immune
 *  to the global event stream's keeper-batch burial, so it recovers the keeper's
 *  permissionless auto-redeem of a settled winner (signed by the keeper, invisible to the
 *  owner/session sender scan). Newest-first, bounded — redeems are a market's last activity,
 *  right after settlement. */
async function scanMarketAccountRedeems(
  marketId: string,
  accountId: string,
  wantRoots: Set<string>,
  opts?: GetOptions,
): Promise<V2OrderEvent[]> {
  const want = accountId.toLowerCase();
  const out: V2OrderEvent[] = [];
  // Stop as soon as every open root in this market has its redeem — a settled market's
  // keeper redeems are its newest txs, so this is usually satisfied on page 1. (A LIVE
  // market has no redeem, so `remaining` never empties and it just pages to the cap.)
  const remaining = new Set(wantRoots);
  let cursor: unknown = null;
  const PAGE = 50;
  for (let i = 0; i < 3; i++) {
    const r = await rpcCall<{ data?: TxBlock[]; nextCursor?: unknown; hasNextPage?: boolean }>(
      'suix_queryTransactionBlocks',
      [{ filter: { InputObject: marketId }, options: { showEvents: true } }, cursor ?? null, PAGE, true],
      opts,
    ).catch(() => ({ data: [] as TxBlock[], nextCursor: null, hasNextPage: false }));
    for (const tx of r?.data ?? []) {
      for (const ev of tx.events ?? []) {
        const struct = orderStructOf(ev.type);
        if (!struct || struct === 'OrderMinted') continue; // redeems only
        const p = ev.parsedJson ?? {};
        if (String(p.account_id ?? '').toLowerCase() !== want) continue;
        if (String(p.expiry_market_id ?? '') !== marketId) continue;
        out.push({ ...p, kind: ORDER_EVENTS[struct], checkpoint_timestamp_ms: n(p.redeemed_at_ms ?? p.minted_at_ms) });
        remaining.delete(String(p.position_root_id ?? p.order_id ?? ''));
      }
    }
    if (remaining.size === 0) break; // every open root here is accounted for — stop early
    if (!r?.hasNextPage || !r?.nextCursor) break;
    cursor = r.nextCursor;
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

/** Scan ONE sender's txs via the FromAddress filter (the whale-immune read), collecting
 *  its order events AND any SessionAuthorized events (which only appear for the owner, as
 *  authorize_session is owner-signed). Extracted so onchainOwnerOrders can fold in the
 *  account's delegated-session keys alongside the wallet owner. */
async function scanSenderOrders(sender: string, maxTx: number, opts?: GetOptions): Promise<SenderScan> {
  const orders: V2OrderEvent[] = [];
  const auths: SessionAuth[] = [];
  let cursor: unknown = null;
  const PAGE = 50;
  for (let i = 0; orders.length < maxTx * 2 && i < Math.ceil(maxTx / PAGE) + 1; i++) {
    const r = await rpcCall<{ data?: TxBlock[]; nextCursor?: unknown; hasNextPage?: boolean }>(
      'suix_queryTransactionBlocks',
      [{ filter: { FromAddress: sender }, options: { showEvents: true } }, cursor ?? null, PAGE, true],
      opts,
    ).catch(() => ({ data: [] as TxBlock[], nextCursor: null, hasNextPage: false }));
    for (const tx of r?.data ?? []) {
      for (const ev of tx.events ?? []) {
        const struct = orderStructOf(ev.type);
        if (struct) {
          const p = ev.parsedJson ?? {};
          orders.push({ ...p, kind: ORDER_EVENTS[struct], checkpoint_timestamp_ms: n(p.minted_at_ms ?? p.redeemed_at_ms) });
        } else if (ev.type && SESSION_AUTHORIZED_RE.test(ev.type)) {
          const p = ev.parsedJson ?? {};
          learnedSessionAuthType ??= ev.type; // warm the by-account backstop's type
          if (p.session) auths.push({ session: String(p.session), accountId: String(p.account_id ?? ''), type: ev.type });
        }
      }
    }
    if (!r?.hasNextPage || !r?.nextCursor) break;
    cursor = r.nextCursor;
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
export async function onchainMarketOpenInterest(
  marketId: string,
  opts?: GetOptions,
): Promise<V2OpenInterest> {
  const want = marketId.toLowerCase();
  // Deep: one focused market — page so a busy market's full open set is counted
  // (max payout at risk / exposure), not just the newest 50 orders.
  const rows = await scanOrderEvents((p) => String(p.expiry_market_id).toLowerCase() === want, 300, opts, true);
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
  return {
    expiry_market_id: marketId,
    open_order_count,
    open_quantity: openQty.toString(),
    open_floor_shares: '0',
  };
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
