'use client';

/**
 * useV2Leaderboard — the real Season-2 board.
 *
 * The beta indexer has NO global order stream (legacy's `/positions/minted` +
 * `/positions/redeemed` equivalent 404s here), so the board is reconstructed by
 * fanning `/markets/:id/orders` across EVERY market the indexer retains. Its
 * `/markets` endpoint caps server-side at ~500 rows (~8h on a minute-rolling
 * venue) — that 500-market set IS the full indexed universe, so we scan all of
 * it, not a 60-market slice. That captures every wallet that has traded in the
 * retained window (the honest "all trades whether recent or not" the indexer can
 * give us).
 *
 * One bounded-concurrency fetch inside a single query (legacy's cheap single-shot
 * pattern), NOT 500 live query subscriptions — a busy indexer stays happy and the
 * board can't blow up the render tree. The connected wallet's OWN complete account
 * history is folded in on top, so a trader whose markets have aged out of even the
 * ~8h window still appears with real, complete stats.
 *
 * Server-data only (the wallet is just for the "you" merge + highlight), so it
 * renders for any visitor.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getV2Markets, getMarketOrders, getAccountOrders, qkV2 } from '@/lib/api/v2/client';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { predictV2Config } from '@/config/predict';
import { aggregateV2Leaderboard } from '@/lib/leaderboard/v2-aggregate';
import type { V2LeaderboardRow } from '@/lib/leaderboard/v2';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

/** The indexer's own ceiling on `/markets` — request it all; anything beyond is
 *  simply not retained server-side (no older markets exist to scan). */
const MARKET_LIMIT = 500;
const ORDERS_PER_MARKET = 200;
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
  // even for markets aged past the retained window. (There's no all-accounts
  // feed, so only the connected user gets this completeness guarantee.)
  const acct = usePredictAccountV2();
  const accountId = acct.accountId;

  const q = useQuery<V2LeaderboardRow[]>({
    // Account-scoped: connecting a wallet re-runs with its history merged in.
    queryKey: [...qkV2.markets, 'leaderboard', accountId ?? 'anon'] as const,
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
          byMarket.set(id, await getMarketOrders(id, ORDERS_PER_MARKET, { signal }));
        } catch {
          /* skip a single unavailable market feed */
        }
      });

      // 3. Fold the connected wallet's complete history into its market buckets
      //    (creating buckets for markets that aged out of the roster).
      if (accountId) {
        try {
          const mine = await getAccountOrders(accountId, { signal });
          for (const o of mine) {
            const mid = (o.expiry_market_id ?? o.market_id) as string | undefined;
            if (!mid) continue;
            const list = byMarket.get(mid);
            if (list) list.push(o);
            else byMarket.set(mid, [o]);
          }
        } catch {
          /* the board still stands without the personal merge */
        }
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
