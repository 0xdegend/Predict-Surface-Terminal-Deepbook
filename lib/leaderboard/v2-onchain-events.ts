/**
 * lib/leaderboard/v2-onchain-events.ts — the complete, all-time SKEW leaderboard,
 * read straight from the chain's order-event stream via GraphQL.
 *
 * The beta indexer has no account-list / global-order endpoint (still 404), so the
 * fan-out board (useV2Leaderboard) can only see a ~8h market window. For SKEW
 * specifically we don't need the whole protocol: a bet placed through the app carries
 * its on-chain `builder_code_id`, so scanning the predict package's `order_events`
 * and keeping only Skew-attributed mints (plus the redeems that close them) yields a
 * full, all-time board of Skew traders with no indexer endpoint at all.
 *
 * Read path = the fullnode's GraphQL RPC (Sui disabled JSON-RPC event queries on
 * testnet 2026-07-08; GraphQL is the sanctioned replacement — same path as
 * lib/leaderboard/skew-traders.ts). Server-only (called from the /api/v2/leaderboard
 * route via the cache), so the scan never runs in the browser.
 */
import { predictV2Config } from '@/config/predict';
import { normalizeOrderEvent } from '@/lib/api/v2/event-compat';
import { aggregateV2Leaderboard } from './v2-aggregate';
import type { V2LeaderboardRow } from './v2';
import type { V2OrderEvent } from '@/lib/api/v2/types';

/** Move event structs in `predict::order_events` → the indexer `kind` the shared
 *  aggregator folds on. */
const EVENT_KIND: Record<string, string> = {
  OrderMinted: 'order_minted',
  LiveOrderRedeemed: 'live_order_redeemed',
  SettledOrderRedeemed: 'settled_order_redeemed',
  LiquidatedOrderRedeemed: 'liquidated_order_redeemed',
};

/** GraphQL caps event pages at 50 nodes. */
const PAGE = 50;
/** Per event type, how far back to walk (newest-first). Skew is a young, low-volume
 *  app, so a few thousand recent events cover its whole history; the cap only stops a
 *  busy protocol whale's non-Skew mints from spinning the loop toward genesis. */
const MAX_PAGES = 40;

const graphqlUrl = () => `https://graphql.${predictV2Config.network}.sui.io/graphql`;

// Page NEWEST-first (last/before) so recent Skew activity is captured within the cap
// even when non-Skew events dominate the stream.
const EVENTS_QUERY = `query OrderEvents($type: String!, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: { type: $type }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { timestamp contents { json } }
  }
}`;

interface EventNode {
  timestamp?: string | null;
  contents?: { json?: Record<string, unknown> | null } | null;
}
interface EventsPage {
  pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  nodes?: EventNode[];
}
interface GraphQLResponse {
  data?: { events?: EventsPage };
  errors?: { message?: string }[];
}

const toMs = (iso?: string | null): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/**
 * One POST to the public GraphQL endpoint, retrying a 429.
 *
 * This walk is four event types deep and up to forty pages each, so a full scan is
 * ~160 requests in a burst and the public endpoint rate-limits it. Without a retry the
 * whole board read fails on the first throttled page, which is a bad trade: the data is
 * there, we just asked for it too quickly. Backoff is exponential from 400ms and gives
 * up after four tries so a genuinely down endpoint still fails fast rather than hanging
 * a request for minutes.
 */
async function postWithBackoff(body: string, signal?: AbortSignal): Promise<Response> {
  let wait = 400;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(graphqlUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body,
    });
    if (res.status !== 429 || attempt >= 3) return res;
    await new Promise((r) => setTimeout(r, wait));
    wait *= 2;
  }
}

/** Walk one event type newest-first, normalizing each node into the V2OrderEvent
 *  shape the shared aggregator understands (the Move struct json + a derived `kind`
 *  + the event timestamp). */
async function pageEvents(structName: string, signal?: AbortSignal): Promise<V2OrderEvent[]> {
  const type = `${predictV2Config.packages.predict}::order_events::${structName}`;
  const kind = EVENT_KIND[structName];
  const out: V2OrderEvent[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await postWithBackoff(
      JSON.stringify({ query: EVENTS_QUERY, variables: { type, last: PAGE, before: cursor } }),
      signal,
    );
    if (!res.ok) throw new Error(`order-events query ${res.status}`);
    const json = (await res.json()) as GraphQLResponse;
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'order-events query failed');
    const events = json.data?.events ?? {};

    for (const node of events.nodes ?? []) {
      const j = node.contents?.json;
      if (!j) continue;
      // 8-21 renamed the stake to `premium` and the stamp to `onchain_timestamp_ms`.
      // Normalize before the row is scored, or every point on the board reads as 0.
      out.push({ ...normalizeOrderEvent(j, kind), kind, checkpoint_timestamp_ms: toMs(node.timestamp) } as V2OrderEvent);
    }

    if (!events.pageInfo?.hasPreviousPage || events.pageInfo.startCursor == null) break;
    cursor = events.pageInfo.startCursor;
  }
  return out;
}

/**
 * Keep only the Skew slice of an order-event set: mints carrying the app's builder
 * code, plus every redeem that closes one of those mints (joined by position root).
 * Pure — operates on the fully-scanned set, so root membership is complete regardless
 * of the order events were paged in.
 */
export function filterSkewEvents(all: V2OrderEvent[], builderCodeId: string): V2OrderEvent[] {
  const skewRoots = new Set<string>();
  for (const e of all) {
    if (e.kind === 'order_minted' && e.builder_code_id === builderCodeId && e.position_root_id != null) {
      skewRoots.add(String(e.position_root_id));
    }
  }
  return all.filter((e) => {
    if (e.kind === 'order_minted') return e.builder_code_id === builderCodeId;
    // a redeem is ours iff it closes one of our mints
    return e.position_root_id != null && skewRoots.has(String(e.position_root_id));
  });
}

/**
 * The complete, all-time Skew leaderboard (6-24): scan every order-event type via
 * GraphQL, keep the Skew-attributed slice, and fold it with the SAME aggregator the
 * fan-out board uses (so points / PnL / holding time are computed identically).
 * Server-only. Empty when no builder code is configured. (7-29 serves the Skew board
 * from the accumulating indexer instead — see lib/leaderboard/v2-indexer.ts.)
 */
/**
 * Every order event in the scan window, from all four streams, unfiltered.
 *
 * Split out from `fetchSkewEvents` so the GraphQL reader can be exercised WITHOUT a builder
 * code configured. That matters on a fresh deployment: until the code is registered,
 * `fetchSkewEvents` correctly returns nothing, which makes it useless for proving the
 * reader itself still parses the new event shape.
 */
export async function fetchAllOrderEvents(signal?: AbortSignal): Promise<V2OrderEvent[]> {
  return (await Promise.all(Object.keys(EVENT_KIND).map((struct) => pageEvents(struct, signal)))).flat();
}

/** Every Skew-attributed order event in the scan window, unaggregated. */
export async function fetchSkewEvents(signal?: AbortSignal): Promise<V2OrderEvent[]> {
  const builderCodeId = predictV2Config.builderCodeId;
  if (!builderCodeId) return [];
  return filterSkewEvents(await fetchAllOrderEvents(signal), builderCodeId);
}

/**
 * The scan's rows. Split from the scan itself so a caller that wants the raw events
 * (the redeploy seed capture, which derives per-wallet history from them) does not have
 * to walk all four event streams a second time.
 */
/** Score an already-scanned Skew event set into board rows. Pure. */
export function skewRowsFromEvents(events: V2OrderEvent[]): V2LeaderboardRow[] {
  const builderCodeId = predictV2Config.builderCodeId;
  // The aggregator folds a Map<marketId, events[]>; group by market so its holding
  // time / redeem-join logic behaves exactly as it does on the fan-out board.
  const byMarket = new Map<string, V2OrderEvent[]>();
  for (const e of events) {
    const mid = (e.expiry_market_id as string | undefined) ?? '_';
    const list = byMarket.get(mid);
    if (list) list.push(e);
    else byMarket.set(mid, [e]);
  }
  return aggregateV2Leaderboard(byMarket, builderCodeId, Date.now());
}

/**
 * The scan's rows. Scan and score are split so a caller that also wants the raw events
 * (the redeploy seed capture, which derives per-wallet history from them) can do both
 * off ONE walk instead of paging all four event streams twice.
 */
export async function fetchSkewLeaderboardRows(signal?: AbortSignal): Promise<V2LeaderboardRow[]> {
  if (!predictV2Config.builderCodeId) return [];
  return skewRowsFromEvents(await fetchSkewEvents(signal));
}
