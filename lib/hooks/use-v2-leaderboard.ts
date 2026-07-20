'use client';

/**
 * useV2Leaderboard — the real Season-2 board.
 *
 * The beta indexer has NO global order stream (legacy's `/positions/minted` +
 * `/positions/redeemed` equivalent 404s here), so the board is reconstructed by
 * fanning `/markets/:id/orders` across EVERY market the indexer retains. Its
 * `/markets` endpoint caps server-side at ~500 rows (~8h on a minute-rolling
 * venue) — that 500-market set IS the full indexed universe, so we scan all of
 * it. That captures every wallet that has traded in the retained window (the
 * honest "all trades whether recent or not" the indexer can give us).
 *
 * INTERIM by design: this is the last-8h window + connected/featured-wallet full
 * history. A complete all-time board needs the indexer's account-list / global
 * order endpoint (still 404, expected live this week). When it lands, swap the
 * fan-out for a fetch of that endpoint — the return shape here stays the same.
 *
 * One bounded-concurrency fetch inside a single query (legacy's cheap single-shot
 * pattern), NOT 500 live query subscriptions — a busy indexer stays happy and the
 * board can't blow up the render tree. On top, we fold in the COMPLETE account
 * history of the connected wallet AND any config `featuredWallets` (resolved
 * address → account id on-chain), so a trader whose markets have aged out of even
 * the ~8h window still appears with real, complete stats.
 *
 * Server-data only (the wallet is just for the "you" merge + highlight), so it
 * renders for any visitor.
 */
import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { getV2Markets, getMarketOrders, getAccountOrders, qkV2 } from '@/lib/api/v2/client';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { readWrapper, readAccountId } from '@/lib/sui/v2/account';
import { predictV2Config } from '@/config/predict';
import { aggregateV2Leaderboard } from '@/lib/leaderboard/v2-aggregate';
import type { V2LeaderboardRow } from '@/lib/leaderboard/v2';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

/** The indexer's own ceiling on `/markets` — request it all; anything beyond is
 *  simply not retained server-side (no older markets exist to scan). */
const MARKET_LIMIT = 500;
/** Per-market order cap. The server allows ≥500; the busiest single market had
 *  369 trades, so 200 was dropping ~169 on the hottest markets. Take the full
 *  budget so no market's traders are truncated (verified live 2026-07-18). */
const ORDERS_PER_MARKET = 500;
/** In-flight order fetches. Browsers cap ~6 sockets/host anyway; this just keeps
 *  that pipe full without scheduling 500 requests at once. */
const CONCURRENCY = 12;

/** Stable identity for an order event, to dedupe the market + account feeds. */
const eventKey = (o: V2OrderEvent): string => {
  const r = o as { event_digest?: string; digest?: string; event_index?: number };
  return r.event_digest ?? `${r.digest ?? ''}-${r.event_index ?? ''}-${o.kind ?? ''}-${o.order_id ?? ''}`;
};

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapPool(items: string[], limit: number, worker: (id: string) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/**
 * Retry a fetch a few times before giving up. The beta indexer occasionally
 * drops a request under the fan-out; without this a single transient failure
 * silently evicts that market's — or a pinned trader's — orders for the whole
 * cycle, which is what made known traders blink on and off the board.
 */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw err;
}

export interface UseV2Leaderboard {
  rows: V2LeaderboardRow[];
  /** Rows attributable to the Skew app (bets that carried its builder code). */
  skewRows: V2LeaderboardRow[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
}

export function useV2Leaderboard(): UseV2Leaderboard {
  // The connected wallet's internal account id — folded into the board below so
  // the connected trader always appears with their full cross-market history,
  // even for markets aged past the retained window.
  const acct = usePredictAccountV2();
  const accountId = acct.accountId;

  // Featured wallets get the SAME completeness as the connected wallet: their
  // full account history is folded in so they never age out of the board.
  // Resolve address → account id once on-chain (deterministic + stable → cache
  // forever); the beta indexer files orders under the internal account id.
  const client = useCurrentClient();
  const featured = predictV2Config.featuredWallets;
  const featuredQ = useQuery<string[]>({
    queryKey: ['v2', 'leaderboard', 'featured-account-ids', ...featured] as const,
    queryFn: async () => {
      const ids: string[] = [];
      let transient = false;
      for (const owner of featured) {
        try {
          const w = await readWrapper(client.core, owner);
          // w.exists === false → wallet never traded: a permanent, silent skip.
          if (w.exists) ids.push(await readAccountId(client.core, w.wrapperId));
        } catch {
          // A flaky on-chain read — NOT a permanent "never traded". Flag it so we
          // reject below and react-query retries, instead of caching a partial
          // pin set under staleTime:Infinity (which dropped the pin until reload).
          transient = true;
        }
      }
      if (transient) throw new Error('featured-wallet resolution incomplete — retrying');
      return ids;
    },
    enabled: featured.length > 0,
    staleTime: Infinity,
    retry: 4,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 15_000),
  });
  const featuredAccountIds = useMemo(() => featuredQ.data ?? [], [featuredQ.data]);

  // Every account whose complete history we fold in: the connected wallet plus
  // the featured pins, deduped (a featured wallet that's also connected once).
  const mergeAccountIds = useMemo(
    () => [...new Set([...(accountId ? [accountId] : []), ...featuredAccountIds])],
    [accountId, featuredAccountIds],
  );

  const q = useQuery<V2LeaderboardRow[]>({
    queryKey: [...qkV2.markets, 'leaderboard', ...mergeAccountIds.sort()] as const,
    queryFn: async ({ signal }) => {
      // 1. The full retained market roster, newest-first, deduped by id.
      const raw = await getV2Markets(MARKET_LIMIT, { signal });
      const byId = new Map<string, V2Market>();
      for (const m of raw) {
        const prev = byId.get(m.expiry_market_id);
        if (!prev || m.checkpoint_timestamp_ms > prev.checkpoint_timestamp_ms) byId.set(m.expiry_market_id, m);
      }
      const ids = [...byId.values()]
        .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
        .map((m) => m.expiry_market_id);

      // 2. Fan the per-market order feeds out (bounded). One market's feed
      //    failing must not sink the whole board.
      const byMarket = new Map<string, V2OrderEvent[]>();
      await mapPool(ids, CONCURRENCY, async (id) => {
        try {
          byMarket.set(id, await withRetry(() => getMarketOrders(id, ORDERS_PER_MARKET, { signal })));
        } catch {
          /* skip a single genuinely-unavailable market feed */
        }
      });

      // 3. Fold each completeness account's full history into its market buckets
      //    (connected wallet + featured pins), creating buckets for markets that
      //    aged out of the roster. One failing fetch can't sink the board.
      await Promise.all(
        mergeAccountIds.map(async (id) => {
          try {
            const orders = await withRetry(() => getAccountOrders(id, 500, { signal }));
            for (const o of orders) {
              const mid = (o.expiry_market_id ?? o.market_id) as string | undefined;
              if (!mid) continue;
              const list = byMarket.get(mid);
              if (list) list.push(o);
              else byMarket.set(mid, [o]);
            }
          } catch {
            /* the board still stands without this account's merge */
          }
        }),
      );

      // 4. Dedupe each bucket by event identity (a market in both feeds).
      for (const [mid, list] of byMarket) {
        const seen = new Set<string>();
        byMarket.set(
          mid,
          list.filter((o) => {
            const k = eventKey(o);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }),
        );
      }

      return aggregateV2Leaderboard(byMarket, predictV2Config.builderCodeId, Date.now());
    },
    staleTime: 30_000,
    // Keep the last good board on screen while a refetch (or a pin resolving,
    // which changes the query key) is in flight, so a transient shrink never
    // flashes traders off the board mid-cycle.
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => q.data ?? [], [q.data]);
  const skewRows = useMemo(() => rows.filter((r) => r.viaSkew), [rows]);

  return {
    rows,
    skewRows,
    loading: q.isLoading,
    refreshing: q.isFetching,
    error: q.error instanceof Error ? q.error.message : null,
    refetch: () => q.refetch(),
  };
}
