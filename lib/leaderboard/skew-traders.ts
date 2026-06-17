/**
 * lib/leaderboard/skew-traders.ts — the set of addresses that have actually
 * traded ON SKEW (vs. the whole DeepBook Predict protocol).
 *
 * Every trade placed through the Skew app routes through the on-chain skew_fee
 * `fee_router`, which emits a `FeeCharged { sender, bet_cost, ... }` event per
 * mint. So the set of `sender`s IS the Skew trader roster — provable on-chain,
 * not app-side tracking. The public predict-server doesn't index these (they're
 * Skew's own contract events), so we read them straight from the fullnode via
 * `suix_queryEvents`. (Direct protocol mints that bypass the app don't emit
 * FeeCharged and are correctly excluded — they aren't Skew trades.)
 *
 * gRPC has no simple event query, so this is a plain JSON-RPC fetch — the one
 * place we touch JSON-RPC, for a read the gRPC core client doesn't expose.
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
interface QueryEventsResult {
  data?: { parsedJson?: FeeChargedJson }[];
  nextCursor?: unknown;
  hasNextPage?: boolean;
}

const PAGE = 200;
/** Hard cap so a busy market can never spin the loop forever (6k events). */
const MAX_PAGES = 30;

const rpcUrl = () => `https://fullnode.${predictConfig.network}.sui.io`;

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
  let cursor: unknown = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_queryEvents',
        params: [{ MoveEventType: type }, cursor, PAGE, true], // descending
      }),
    });
    if (!res.ok) throw new Error(`queryEvents ${res.status}`);
    const json = (await res.json()) as { result?: QueryEventsResult; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? 'queryEvents failed');
    const result = json.result ?? {};

    for (const e of result.data ?? []) {
      const sender = e.parsedJson?.sender;
      if (!sender) continue;
      const owner = sender.toLowerCase();
      addresses.add(owner);
      const vol = fromQuote(Number(e.parsedJson?.bet_cost ?? 0));
      const prev = byOwner.get(owner) ?? { skewVolume: 0, skewTrades: 0 };
      prev.skewVolume += Number.isFinite(vol) ? vol : 0;
      prev.skewTrades += 1;
      byOwner.set(owner, prev);
    }

    if (!result.hasNextPage || result.nextCursor == null) break;
    cursor = result.nextCursor;
  }

  return { addresses, byOwner };
}
