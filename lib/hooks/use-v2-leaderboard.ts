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
import { useV2ReadClient } from '@/lib/sui/grpc';
import { getV2Markets, getMarketOrders, getAccountOrders, getV2AllOrders, qkV2 } from '@/lib/api/v2/client';
import { onchainSkewOwners, onchainOwnerOrders } from '@/lib/api/v2/onchain';
import { mapPool, withRetry } from '@/lib/api/v2/fan-out';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { readWrapper, readAccountId } from '@/lib/sui/v2/account';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
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
/** 7-29 only: how far back (per event type) the ONE global order scan pages. The
 *  chain's event index serves the whole stream, so a single deep scan replaces the
 *  per-market fan-out; the walk stops early when the feed ends, so this is a cap,
 *  not a fixed cost. Sized to capture a busy account's full recent run. */
const GLOBAL_ORDERS = 800;

/** Stable identity for an order event, to dedupe the market + account feeds. */
const eventKey = (o: V2OrderEvent): string => {
  const r = o as { event_digest?: string; digest?: string; event_index?: number };
  return r.event_digest ?? `${r.digest ?? ''}-${r.event_index ?? ''}-${o.kind ?? ''}-${o.order_id ?? ''}`;
};

export interface UseV2Leaderboard {
  rows: V2LeaderboardRow[];
  /** Rows attributable to the Skew app (bets that carried its builder code) — the
   *  complete all-time board from the on-chain scan, not the fan-out window. */
  skewRows: V2LeaderboardRow[];
  loading: boolean;
  /** First-load state of the Skew board specifically (its scan is a separate query). */
  skewLoading: boolean;
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
  const client = useV2ReadClient();
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
      const byMarket = new Map<string, V2OrderEvent[]>();

      if (ACTIVE_V2_DEPLOYMENT === '7-29') {
        // 7-29: the chain's own event index serves the WHOLE order stream, so ONE
        // global paged scan replaces the per-market fan-out (which on 7-29 would
        // re-query the same global newest-page once per market — costly + thin).
        // Bucket by market so the aggregator's redeem→mint join behaves identically.
        const all = await getV2AllOrders(GLOBAL_ORDERS, { signal });
        for (const o of all) {
          const mid = (o.expiry_market_id ?? o.market_id) as string | undefined;
          if (!mid) continue;
          const list = byMarket.get(mid);
          if (list) list.push(o);
          else byMarket.set(mid, [o]);
        }
      } else {
        // 6-24: no global endpoint — fan the per-market feeds out across the full
        // retained market roster (newest-first, deduped by id). One market's feed
        // failing must not sink the whole board.
        const raw = await getV2Markets(MARKET_LIMIT, { signal });
        const byId = new Map<string, V2Market>();
        for (const m of raw) {
          const prev = byId.get(m.expiry_market_id);
          if (!prev || m.checkpoint_timestamp_ms > prev.checkpoint_timestamp_ms) byId.set(m.expiry_market_id, m);
        }
        const ids = [...byId.values()]
          .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
          .map((m) => m.expiry_market_id);
        await mapPool(ids, CONCURRENCY, async (id) => {
          try {
            byMarket.set(id, await withRetry(() => getMarketOrders(id, ORDERS_PER_MARKET, { signal })));
          } catch {
            /* skip a single genuinely-unavailable market feed */
          }
        });
      }

      // 3. Fold in complete per-user history so real traders always appear, even when
      //    a high-frequency bot buries them in the windowed scan above.
      const foldOwnerOrders = (orders: V2OrderEvent[]) => {
        for (const o of orders) {
          const mid = (o.expiry_market_id ?? o.market_id) as string | undefined;
          if (!mid) continue;
          const list = byMarket.get(mid);
          if (list) list.push(o);
          else byMarket.set(mid, [o]);
        }
      };
      if (ACTIVE_V2_DEPLOYMENT === '7-29') {
        // Read each by TX SENDER (server-side filtered → whale-immune). The union of
        // the connected wallet, config-featured pins, and everyone who has attributed
        // a trade to us — so app users are never absent from the venue board.
        const skewOwners = predictV2Config.builderCodeId
          ? await onchainSkewOwners(predictV2Config.builderCodeId, { signal }).catch(() => [] as string[])
          : [];
        const owners = [
          ...new Set(
            [...(acct.owner ? [acct.owner] : []), ...predictV2Config.featuredWallets, ...skewOwners].map((o) =>
              o.toLowerCase(),
            ),
          ),
        ];
        await Promise.all(
          owners.map(async (o) => foldOwnerOrders(await onchainOwnerOrders(o, 200, { signal }).catch(() => []))),
        );
      } else {
        // 6-24: the indexer isn't bot-buried, so fold by account id (its native key).
        await Promise.all(
          mergeAccountIds.map(async (id) => {
            try {
              foldOwnerOrders(await withRetry(() => getAccountOrders(id, 500, { signal })));
            } catch {
              /* the board still stands without this account's merge */
            }
          }),
        );
      }

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

  // The all-time SKEW board comes from the server route — a GraphQL scan of the
  // chain's order events, filtered to bets carrying the app's builder code. That's a
  // COMPLETE history (no account-list endpoint needed), unlike the ~8h fan-out window
  // above, so the Skew tab isn't capped by what the indexer still retains.
  const skewQ = useQuery<V2LeaderboardRow[]>({
    queryKey: ['v2', 'leaderboard', 'skew-onchain'] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/v2/leaderboard', { signal });
      if (!res.ok) throw new Error(`skew leaderboard ${res.status}`);
      const snap = (await res.json()) as { rows?: V2LeaderboardRow[] };
      return snap.rows ?? [];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => q.data ?? [], [q.data]);
  const skewRows = useMemo(() => skewQ.data ?? [], [skewQ.data]);

  return {
    rows,
    skewRows,
    loading: q.isLoading,
    skewLoading: skewQ.isLoading,
    refreshing: q.isFetching || skewQ.isFetching,
    error:
      q.error instanceof Error
        ? q.error.message
        : skewQ.error instanceof Error
          ? skewQ.error.message
          : null,
    refetch: () => {
      q.refetch();
      skewQ.refetch();
    },
  };
}
