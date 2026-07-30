'use client';

/**
 * useV2Analytics — REAL analytics for the v2 Analytics page, reconstructed from
 * the per-market feeds (there is no global flow endpoint).
 *
 * TWO market scopes, on purpose:
 *   - RECENT (active + markets expired in the last ~20 min) drives the order
 *     pool → flow tape, sentiment, biggest bet, total volume, trader styles.
 *     A 1-minute market's bets vanish from the active list within a minute, so
 *     without this window "Latest bets" empties seconds after a bet is placed.
 *   - ACTIVE (live only) drives the per-market widgets — the markets treemap /
 *     hottest list, open interest, and the ATM implied-vol "price swing" — where
 *     an expired market's countdown or IV would be meaningless.
 *
 * All per-market reads (orders, OI) come from `/markets/:id/*`; volume/bets are
 * summed from the ORDERS feed (marketVolumeFromOrders), the same fast source as
 * the flow tape — NOT the bucketed `/activity` rollups, which lagged behind the
 * orders and stopped at expiry, so a live bet read as $0 volume. Bounded by the
 * recent-market cap; all queries share TanStack keys so a double-mount dedupes.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useV2RecentMarkets } from './use-v2-markets';
import { useV2Pricers } from './use-v2-pricers';
import { useNow } from './use-now';
import { getMarketOrders, getMarketOpenInterest, qkV2 } from '@/lib/api/v2/client';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import {
  flowRows,
  marketCells,
  kpisFromData,
  sentimentFromOrders,
  type MarketInputs,
  type FlowRow,
  type MarketCell,
  type Kpis,
  type Sentiment,
} from '@/lib/analytics/v2-aggregate';
import type { V2Market, V2OrderEvent, V2OpenInterest } from '@/lib/api/v2/types';

export interface UseV2Analytics {
  cells: MarketCell[];
  kpis: Kpis;
  sentiment: Sentiment;
  flow: FlowRow[];
  isLoading: boolean;
  /** True once at least one market's feeds have resolved. */
  hasData: boolean;
}

const ORDERS_PER_MARKET = 60;
/** How far past expiry a market's bets stay in the recent window. */
const RECENT_LOOKBACK_MS = 20 * 60_000;
/** Cap on the recent-market fan-out (newest first) — bounds the request count. */
const RECENT_MARKET_CAP = 30;

export function useV2Analytics(initialMarkets: V2Market[], spot: number | null): UseV2Analytics {
  // Recent window (active + just-expired) for the order pool; the live subset
  // for the per-market widgets.
  const markets = useV2RecentMarkets(initialMarkets, RECENT_LOOKBACK_MS, RECENT_MARKET_CAP);
  const now = useNow(0);
  const ids = markets.map((m) => m.expiry_market_id);
  const activeMarkets = useMemo(() => markets.filter((m) => m.expiry > now), [markets, now]);
  const activeIds = activeMarkets.map((m) => m.expiry_market_id);

  // Orders across the whole recent window (flow / sentiment / volume / biggest).
  const ordersQ = useQueries({
    queries: ids.map((id) => ({
      queryKey: qkV2.marketOrders(id),
      queryFn: () => getMarketOrders(id, ORDERS_PER_MARKET),
      refetchInterval: 8_000,
      staleTime: 6_000,
    })),
  });
  // Open interest only for LIVE markets (open bets right now — moot once expired).
  const oiQ = useQueries({
    queries: activeIds.map((id) => ({
      queryKey: qkV2.marketOpenInterest(id),
      queryFn: () => getMarketOpenInterest(id),
      refetchInterval: 15_000,
      staleTime: 12_000,
    })),
  });

  // Live pricers for ATM IV + forward, live markets only. Seeded empty.
  const pricers = useV2Pricers(activeIds, {});

  // Stamp the memo on the loaded data (the query arrays are fresh each render).
  const ordersStamp = ordersQ.map((q) => q.dataUpdatedAt).join(',');
  const oiStamp = oiQ.map((q) => q.dataUpdatedAt).join(',');

  const { ordersByMarket, activeInputs } = useMemo(() => {
    // Order pool over the whole recent window — keyed by market id.
    const ordersByMarket = new Map<string, V2OrderEvent[]>();
    markets.forEach((m, i) => {
      const orders = ordersQ[i]?.data as V2OrderEvent[] | undefined;
      if (orders) ordersByMarket.set(m.expiry_market_id, orders);
    });
    // Per-market inputs for the LIVE cells (treemap / hottest / IV): volume from
    // this market's orders, plus its OI and pricer-derived forward + ATM IV.
    const activeInputs = new Map<string, MarketInputs>();
    activeMarkets.forEach((m, i) => {
      const id = m.expiry_market_id;
      const pricer = pricers[id];
      const atmIv = pricer
        ? impliedVol(pricer.forward, pricer.forward, pricer.svi, Math.max(1e-9, timeToExpiryYears(m.expiry, now)))
        : null;
      activeInputs.set(id, {
        orders: ordersByMarket.get(id),
        oi: (oiQ[i]?.data as V2OpenInterest | undefined)?.open_order_count ?? 0,
        forward: pricer?.forward ?? null,
        atmIv,
      });
    });
    return { ordersByMarket, activeInputs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, activeMarkets, ordersStamp, oiStamp, pricers, now]);

  const cells = useMemo(() => marketCells(activeMarkets, activeInputs, spot), [activeMarkets, activeInputs, spot]);
  const flow = useMemo(() => flowRows(ordersByMarket, markets), [ordersByMarket, markets]);
  const allOrders = useMemo(() => [...ordersByMarket.values()].flat(), [ordersByMarket]);
  const kpis = useMemo(() => kpisFromData(allOrders, activeMarkets.length), [allOrders, activeMarkets.length]);
  const sentiment = useMemo(() => sentimentFromOrders(allOrders), [allOrders]);

  const anyLoading = ordersQ.some((q) => q.isLoading);
  return {
    cells,
    kpis,
    sentiment,
    flow,
    isLoading: anyLoading && flow.length === 0,
    hasData: ordersByMarket.size > 0,
  };
}
