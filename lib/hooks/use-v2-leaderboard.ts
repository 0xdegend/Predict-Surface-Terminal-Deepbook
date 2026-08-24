'use client';

/**
 * useV2Leaderboard — the real Season-2 boards (venue-wide "all" + app-attributed
 * "skew").
 *
 * 7-29: BOTH boards come from the server route `/api/v2/leaderboard`, which is backed
 * by the persistent ACCUMULATING indexer (lib/leaderboard/v2-indexer). That indexer
 * folds new trades into a KV-persisted tally, so the boards are complete all-time and
 * a high-frequency bot can never bury real traders in a scan window. The client just
 * fetches the finished standings — no heavy on-chain scanning in the browser.
 *
 * 6-24: the beta indexer has no global order stream, so the venue board is still
 * reconstructed client-side by fanning `/markets/:id/orders` across the retained
 * market roster and folding in the connected + featured wallets' full history; the
 * Skew board comes from the same route (its 6-24 GraphQL scan).
 *
 * 7-29+: the indexer bot-immune-seeds only code/legacy/featured owners, so a FRESH
 * connected wallet can still be buried by the high-frequency bot in the backfill
 * window and miss the venue board. We guarantee "you always see yourself": fetch the
 * connected wallet's own history by tx-sender (whale-immune) and fold its computed
 * row into `all` when the indexer didn't already include it (the indexer row wins if
 * present — it carries complete history + live open-position holding time).
 *
 * Server-data only for anyone else (the wallet is just for the "you" merge + highlight),
 * so it renders for any visitor.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { getV2Markets, getMarketOrders, getAccountOrders, qkV2 } from '@/lib/api/v2/client';
import { mapPool, withRetry } from '@/lib/api/v2/fan-out';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { readWrapper, readAccountId } from '@/lib/sui/v2/account';
import { predictV2Config, V2_IS_729_PLUS } from '@/config/predict';
import { aggregateV2Leaderboard } from '@/lib/leaderboard/v2-aggregate';
import { sortV2Rows, type V2LeaderboardRow } from '@/lib/leaderboard/v2';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

/** 7-29 reads finished boards from the indexer route; the fan-out below is 6-24 only. */
const IS_729 = V2_IS_729_PLUS;

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

export interface UseV2Leaderboard {
  rows: V2LeaderboardRow[];
  /** Rows attributable to the Skew app (bets that carried its builder code). */
  skewRows: V2LeaderboardRow[];
  loading: boolean;
  /** First-load state of the Skew board specifically. */
  skewLoading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
  /** Explicit user refresh: bypass the edge cache, force an indexer rescan, and re-fold
   *  the connected wallet — so a just-made trade shows up. Takes a few seconds. */
  forceRefresh: () => void;
}

interface Boards {
  all: V2LeaderboardRow[];
  skew: V2LeaderboardRow[];
}

export function useV2Leaderboard(): UseV2Leaderboard {
  // The connected wallet's internal account id — folded into the 6-24 board so the
  // connected trader always appears with their full cross-market history.
  const acct = usePredictAccountV2();
  const accountId = acct.accountId;

  // Featured wallets get the SAME completeness as the connected wallet (6-24 only —
  // on 7-29 the indexer already seeds every app user). Resolve address → account id
  // once on-chain (deterministic + stable → cache forever).
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
          if (w.exists) ids.push(await readAccountId(client.core, w.wrapperId));
        } catch {
          transient = true;
        }
      }
      if (transient) throw new Error('featured-wallet resolution incomplete, retrying');
      return ids;
    },
    enabled: !IS_729 && featured.length > 0,
    staleTime: Infinity,
    retry: 4,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 15_000),
  });
  const featuredAccountIds = useMemo(() => featuredQ.data ?? [], [featuredQ.data]);

  const mergeAccountIds = useMemo(
    () => [...new Set([...(accountId ? [accountId] : []), ...featuredAccountIds])],
    [accountId, featuredAccountIds],
  );

  // Set for exactly ONE refetch by forceRefresh, so that fetch bypasses the edge cache
  // (a distinct URL + no-store) and makes the origin rescan. The periodic refetch leaves
  // it false and keeps hitting the cached board, so the CDN still absorbs normal traffic.
  const forceOnceRef = useRef(false);

  // BOTH boards from the server. On 7-29 this is the accumulating indexer (complete,
  // never windowed); on 6-24 it carries only the Skew board (venue board built below).
  const boardsQ = useQuery<Boards>({
    queryKey: ['v2', 'leaderboard', 'boards'] as const,
    queryFn: async ({ signal }) => {
      const fresh = forceOnceRef.current;
      forceOnceRef.current = false; // consume — only this refetch is forced
      const res = await fetch(fresh ? '/api/v2/leaderboard?fresh=1' : '/api/v2/leaderboard', {
        signal,
        cache: fresh ? 'no-store' : 'default',
      });
      if (!res.ok) throw new Error(`leaderboard ${res.status}`);
      const j = (await res.json()) as Partial<Boards>;
      return { all: j.all ?? [], skew: j.skew ?? [] };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  // 7-29+ ONLY: the connected wallet's OWN standing, computed from its full history
  // read by tx-sender (bot-immune). Folded into `all` below so a fresh trader the
  // indexer hasn't captured yet still finds themselves on the venue board. Uses the
  // exact points formula the boards use (aggregateV2Leaderboard), so a self-row and an
  // indexer row for the same wallet are identical.
  const selfQ = useQuery<V2LeaderboardRow[]>({
    queryKey: ['v2', 'leaderboard', 'self', accountId ?? '', acct.owner ?? ''] as const,
    enabled: IS_729 && !!accountId && !!acct.owner,
    queryFn: async ({ signal }) => {
      const orders = await getAccountOrders(accountId!, acct.owner!, 500, { signal });
      if (orders.length === 0) return [];
      // Market bucketing is irrelevant here (aggregate flattens all events) — one bucket.
      return aggregateV2Leaderboard(new Map([['self', orders]]), predictV2Config.builderCodeId, Date.now());
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // 6-24 ONLY: reconstruct the venue board client-side from the per-market fan-out +
  // the connected/featured wallets' full history. Disabled on 7-29 (indexer serves it).
  const q = useQuery<V2LeaderboardRow[]>({
    queryKey: [...qkV2.markets, 'leaderboard', ...mergeAccountIds.sort()] as const,
    enabled: !IS_729,
    queryFn: async ({ signal }) => {
      const byMarket = new Map<string, V2OrderEvent[]>();

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

      // Fold the connected + featured wallets' full history in (by account id).
      await Promise.all(
        mergeAccountIds.map(async (id) => {
          try {
            const orders = await withRetry(() => getAccountOrders(id, undefined, 500, { signal }));
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

      // Dedupe each bucket by event identity (a market in both feeds).
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
    placeholderData: keepPreviousData,
  });

  // The venue board: from the indexer on 7-29, from the client fan-out on 6-24. On
  // 7-29+, fold in the connected wallet's self-row when the indexer hasn't captured it
  // yet (the indexer row wins if present — complete history + live holding time), so a
  // fresh trader always appears. Re-sorted by points to keep the ranking well-ordered.
  const rows = useMemo(() => {
    if (!IS_729) return q.data ?? [];
    const all = boardsQ.data?.all ?? [];
    const self = selfQ.data ?? [];
    if (self.length === 0) return all;
    const have = new Set(all.map((r) => r.owner.toLowerCase()));
    const missing = self.filter((r) => !have.has(r.owner.toLowerCase()));
    return missing.length ? sortV2Rows([...all, ...missing], 'points') : all;
  }, [boardsQ.data, q.data, selfQ.data]);
  const skewRows = useMemo(() => boardsQ.data?.skew ?? [], [boardsQ.data]);

  const allLoading = IS_729 ? boardsQ.isLoading : q.isLoading;

  // Explicit user refresh. Bump the one-shot force flag so the board fetch bypasses the
  // edge cache and the origin rescans, and refetch the connected wallet's own history so
  // their just-made trade folds into `all` even if the indexer hasn't captured it yet.
  const forceRefresh = useCallback(() => {
    forceOnceRef.current = true;
    void boardsQ.refetch();
    void selfQ.refetch();
    if (!IS_729) void q.refetch();
  }, [boardsQ, selfQ, q]);

  return {
    rows,
    skewRows,
    loading: allLoading,
    skewLoading: boardsQ.isLoading,
    refreshing: boardsQ.isFetching || selfQ.isFetching || (!IS_729 && q.isFetching),
    error:
      boardsQ.error instanceof Error
        ? boardsQ.error.message
        : q.error instanceof Error
          ? q.error.message
          : null,
    refetch: () => {
      boardsQ.refetch();
      if (!IS_729) q.refetch();
    },
    forceRefresh,
  };
}
