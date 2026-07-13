'use client';

/**
 * useV2PortfolioPositions — the connected account's REAL positions, enriched into
 * display rows: joined to their market (tick→strike), resolved win/loss off the
 * settlement price, and marked live off the pricer with a probability sparkline.
 *
 * One source of truth so the full Portfolio grid and the compact trade-rail panel
 * render identical figures and never drift. Sample rows / history stay with the
 * caller — this hook only enriches the real indexer rows. All the underlying
 * queries share TanStack keys, so mounting it in two places dedupes the fetches.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useV2Positions } from './use-v2-positions';
import { useV2Pricers } from './use-v2-pricers';
import { useV2MarketStates } from './use-v2-market-states';
import { getV2Markets, getAccountOrders, getPythHistory, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { toFloat } from '@/config/scale';
import {
  normalizeV2Position,
  valueV2Position,
  settleV2Position,
  positionMarkPrice,
  buildV2Spark,
  v2EntryFees,
  type V2PortfolioPosition,
  type SpotPoint,
} from '@/lib/portfolio/v2';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

export interface UseV2PortfolioPositions {
  /** Enriched real rows (settled/valued + sparkline). Empty until the feed reports. */
  positions: V2PortfolioPosition[];
  isLoading: boolean;
  /** market id → market, merged bulk + per-position state (for history joins). */
  marketMap: Map<string, V2Market>;
}

export function useV2PortfolioPositions(accountId?: string): UseV2PortfolioPositions {
  const { positions: rawPositions, isLoading } = useV2Positions(accountId);

  // Every market a position references (from the raw rows — no join needed yet).
  const positionMarketIds = useMemo(
    () => [
      ...new Set(
        rawPositions
          .map((p) => (p.expiry_market_id ?? p.market_id) as string | undefined)
          .filter((id): id is string => !!id),
      ),
    ],
    [rawPositions],
  );

  // Per-position market STATE: market details for the tick→strike join AND the
  // settlement price. Works for EXPIRED markets (rolled off the bulk list below).
  const marketStates = useV2MarketStates(positionMarketIds);

  // Bulk current markets — shares the trade screen's cache. Per-position states
  // (always correct, incl. expired) are layered on top so they win.
  const marketsQ = useQuery({ queryKey: qkV2.markets, queryFn: () => getV2Markets(100), staleTime: 30_000 });
  const marketMap = useMemo(() => {
    const m = new Map((marketsQ.data ?? []).map((mk) => [mk.expiry_market_id, mk]));
    for (const [id, st] of Object.entries(marketStates)) {
      if (st.market) m.set(id, st.market);
    }
    return m;
  }, [marketsQ.data, marketStates]);

  // Settlement price (float $) per market — null while live, final once settled.
  const settlements = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const [id, st] of Object.entries(marketStates)) {
      const sp = st.settlement?.settlement_price;
      out[id] = sp != null ? toFloat(sp) : null;
    }
    return out;
  }, [marketStates]);

  // Fees paid at mint, from the order EVENT log — the positions feed carries the
  // stake but no fees, so without this join the cost basis (and every PnL built
  // on it) is understated. Same TanStack key as useV2History ⇒ one shared fetch.
  const ordersQ = useQuery<V2OrderEvent[]>({
    queryKey: qkV2.accountOrders(accountId ?? ''),
    queryFn: () => getAccountOrders(accountId!),
    enabled: !!accountId,
    refetchInterval: 15_000,
  });
  const entryFees = useMemo(() => v2EntryFees(ordersQ.data ?? []), [ordersQ.data]);

  // Real indexer rows, normalized and joined to their market for tick→price.
  const normalized = useMemo(
    () =>
      rawPositions.map((p, i) =>
        normalizeV2Position(
          p,
          i,
          marketMap.get((p.expiry_market_id ?? p.market_id) as string),
          entryFees.get(String(p.position_root_id ?? p.order_id)) ?? 0,
        ),
      ),
    [rawPositions, marketMap, entryFees],
  );

  // Live pricers for the OPEN positions' markets — the v2 indexer reports no
  // mark/PnL, so we mark each position client-side (bounded: only open markets).
  const openMarketIds = useMemo(
    () => [...new Set(normalized.filter((p) => !p.settled && p.marketId).map((p) => p.marketId!))],
    [normalized],
  );
  const pricers = useV2Pricers(openMarketIds, {});

  // Recent spot history → the position sparklines (a binary's price is its
  // probability). Shares cache with the price chart's `qkV2.pythHistory`.
  const pythHistQ = useQuery({
    queryKey: qkV2.pythHistory,
    queryFn: () => getPythHistory(predictV2Config.asset.pythFeedId, 500),
    refetchInterval: 30_000,
    enabled: openMarketIds.length > 0,
  });
  const spots = useMemo<SpotPoint[]>(
    () =>
      (pythHistQ.data ?? [])
        .map((o) => ({ t: o.checkpoint_timestamp_ms ?? o.source_timestamp_ms ?? 0, s: pythSpot(o) }))
        .filter((d): d is SpotPoint => d.s != null && d.s > 0),
    [pythHistQ.data],
  );

  const positions = useMemo(
    () =>
      normalized.map((p) => {
        // Settled? Resolve win/loss from the market's settlement price first — it's
        // terminal and needs no live pricer. Falls through unchanged while live.
        const settled = settleV2Position(p, p.marketId ? settlements[p.marketId] : null);
        if (settled.settled) return { ...settled, spark: buildV2Spark(settled, undefined, spots) };
        const pricer = p.marketId ? pricers[p.marketId] : undefined;
        const valued = valueV2Position(settled, positionMarkPrice(settled, pricer));
        return { ...valued, spark: buildV2Spark(valued, pricer, spots) };
      }),
    [normalized, pricers, spots, settlements],
  );

  return { positions, isLoading, marketMap };
}
