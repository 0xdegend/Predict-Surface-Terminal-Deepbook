'use client';

/**
 * useV2Analytics — REAL analytics for the v2 Analytics page, reconstructed from
 * the per-market feeds (there is no global flow endpoint). For each active market
 * it fans out:
 *   - /markets/:id/orders    → recent mint/redeem events (flow, sentiment, biggest)
 *   - /markets/:id/activity  → hourly rollups (volume, bet counts)
 *   - /markets/:id/open-interest → open bets right now
 * and reuses the shared live pricers for ATM implied vol (the "price swing").
 * The pure lib/analytics/v2-aggregate folds these into the tool shapes.
 *
 * Bounded by the active-market count (~a dozen), all queries share TanStack keys
 * so mounting the page twice dedupes, and the OI queries dedupe with the risk page.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useV2Markets } from './use-v2-markets';
import { useV2Pricers } from './use-v2-pricers';
import { useNow } from './use-now';
import {
  getMarketOrders,
  getMarketActivity,
  getMarketOpenInterest,
  qkV2,
} from '@/lib/api/v2/client';
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
import type { V2Market, V2OrderEvent, V2ActivityBucket, V2OpenInterest } from '@/lib/api/v2/types';

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
const ACTIVITY_BUCKETS = 24; // ~last day of hourly rollups

export function useV2Analytics(initialMarkets: V2Market[], spot: number | null): UseV2Analytics {
  const markets = useV2Markets(initialMarkets);
  const now = useNow(0);
  const ids = markets.map((m) => m.expiry_market_id);

  const ordersQ = useQueries({
    queries: ids.map((id) => ({
      queryKey: qkV2.marketOrders(id),
      queryFn: () => getMarketOrders(id, ORDERS_PER_MARKET),
      refetchInterval: 8_000,
      staleTime: 6_000,
    })),
  });
  const activityQ = useQueries({
    queries: ids.map((id) => ({
      queryKey: qkV2.marketActivity(id),
      queryFn: () => getMarketActivity(id, ACTIVITY_BUCKETS),
      refetchInterval: 30_000,
      staleTime: 20_000,
    })),
  });
  const oiQ = useQueries({
    queries: ids.map((id) => ({
      queryKey: qkV2.marketOpenInterest(id),
      queryFn: () => getMarketOpenInterest(id),
      refetchInterval: 15_000,
      staleTime: 12_000,
    })),
  });

  // Live pricers for ATM IV + forward. Seeded empty; the hook simulates each.
  const pricers = useV2Pricers(ids, {});

  // Stamp the memo on the loaded data (the query arrays are fresh each render).
  const ordersStamp = ordersQ.map((q) => q.dataUpdatedAt).join(',');
  const activityStamp = activityQ.map((q) => q.dataUpdatedAt).join(',');
  const oiStamp = oiQ.map((q) => q.dataUpdatedAt).join(',');

  const { ordersByMarket, inputs } = useMemo(() => {
    const ordersByMarket = new Map<string, V2OrderEvent[]>();
    const inputs = new Map<string, MarketInputs>();
    markets.forEach((m, i) => {
      const id = m.expiry_market_id;
      const orders = (ordersQ[i]?.data as V2OrderEvent[] | undefined) ?? undefined;
      const activity = (activityQ[i]?.data as V2ActivityBucket[] | undefined) ?? undefined;
      const oi = (oiQ[i]?.data as V2OpenInterest | undefined)?.open_order_count ?? 0;
      const pricer = pricers[id];
      const atmIv = pricer
        ? impliedVol(pricer.forward, pricer.forward, pricer.svi, Math.max(1e-9, timeToExpiryYears(m.expiry, now)))
        : null;
      if (orders) ordersByMarket.set(id, orders);
      inputs.set(id, { orders, activity, oi, forward: pricer?.forward ?? null, atmIv });
    });
    return { ordersByMarket, inputs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, ordersStamp, activityStamp, oiStamp, pricers, now]);

  const cells = useMemo(() => marketCells(markets, inputs, spot), [markets, inputs, spot]);
  const flow = useMemo(() => flowRows(ordersByMarket, markets), [ordersByMarket, markets]);
  const allOrders = useMemo(() => [...ordersByMarket.values()].flat(), [ordersByMarket]);
  const kpis = useMemo(() => kpisFromData(cells, allOrders, markets.length), [cells, allOrders, markets.length]);
  const sentiment = useMemo(() => sentimentFromOrders(allOrders), [allOrders]);

  const anyLoading = ordersQ.some((q) => q.isLoading) || activityQ.some((q) => q.isLoading);
  return {
    cells,
    kpis,
    sentiment,
    flow,
    isLoading: anyLoading && flow.length === 0,
    hasData: ordersByMarket.size > 0,
  };
}
