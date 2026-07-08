/**
 * lib/leaderboard/skew-traders.ts — the set of addresses that have actually
 * traded ON SKEW (vs. the whole DeepBook Predict protocol).
 *
 * Every trade placed through the Skew app routes through the on-chain skew_fee
 * `fee_router`, which emits a `FeeCharged { sender, bet_cost, ... }` event per
 * mint. So the set of `sender`s IS the Skew trader roster — provable on-chain,
 * not app-side tracking. The public predict-server doesn't index these (they're
 * Skew's own contract events), so we read them from the fullnode's **GraphQL
 * RPC** — this used to be a `suix_queryEvents` JSON-RPC call, but Sui Foundation
 * disabled JSON-RPC on testnet fullnodes on 2026-07-08 (gRPC still has no event
 * query, so GraphQL is the sanctioned replacement). (Direct protocol mints that
 * bypass the app don't emit FeeCharged and are correctly excluded — they aren't
 * Skew trades.)
 */
import { predictConfig } from '@/config/predict';
import { fromQuote } from '@/config/scale';

export interface SkewTraders {
  /** Lowercased addresses that have traded through Skew. */
  addresses: Set<string>;
  /** Per-owner Skew-only stats (volume in DUSDC, trade count). */
  byOwner: Map<string, { skewVolume: number; skewTrades: number }>;
}

interface FeeChargedJson {
  sender: string;
  bet_cost: string;
}
interface EventsPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: { contents?: { json?: FeeChargedJson } }[];
}
interface GraphQLResponse {
  data?: { events?: EventsPage };
  errors?: { message?: string }[];
}

/** GraphQL caps event pages at 50 nodes. */
const PAGE = 50;
/** Hard cap so a busy market can never spin the loop forever (3k events). */
const MAX_PAGES = 60;

const graphqlUrl = () => `https://graphql.${predictConfig.network}.sui.io/graphql`;

const EVENTS_QUERY = `query SkewFeeEvents($type: String!, $first: Int!, $after: String) {
  events(first: $first, after: $after, filter: { type: $type }) {
    pageInfo { hasNextPage endCursor }
    nodes { contents { json } }
  }
}`;

/**
 * Walk the `FeeCharged` event stream and fold it into the Skew trader roster +
 * per-owner Skew volume. Empty (no-op) when the fee router isn't configured for
 * this network (e.g. mainnet before publish).
 */
export async function fetchSkewTraders(signal?: AbortSignal): Promise<SkewTraders> {
  const addresses = new Set<string>();
  const byOwner = new Map<string, { skewVolume: number; skewTrades: number }>();

  const pkg = predictConfig.skewFeePackageId;
  if (!pkg) return { addresses, byOwner };

  const type = `${pkg}::fee_router::FeeCharged`;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(graphqlUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        query: EVENTS_QUERY,
        variables: { type, first: PAGE, after: cursor },
      }),
    });
    if (!res.ok) throw new Error(`events query ${res.status}`);
    const json = (await res.json()) as GraphQLResponse;
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'events query failed');
    const events = json.data?.events ?? {};

    for (const e of events.nodes ?? []) {
      const sender = e.contents?.json?.sender;
      if (!sender) continue;
      const owner = sender.toLowerCase();
      addresses.add(owner);
      const vol = fromQuote(Number(e.contents?.json?.bet_cost ?? 0));
      const prev = byOwner.get(owner) ?? { skewVolume: 0, skewTrades: 0 };
      prev.skewVolume += Number.isFinite(vol) ? vol : 0;
      prev.skewTrades += 1;
      byOwner.set(owner, prev);
    }

    if (!events.pageInfo?.hasNextPage || events.pageInfo.endCursor == null) break;
    cursor = events.pageInfo.endCursor;
  }

  return { addresses, byOwner };
}
