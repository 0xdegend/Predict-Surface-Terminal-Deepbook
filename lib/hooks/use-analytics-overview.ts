'use client';

/**
 * useAnalyticsOverview — the data spine for the Pulse dashboard. Composes the
 * shared flow + market-grid hooks (no new fetches) into the at-a-glance reads:
 * protocol KPIs, the hottest markets, the most recent bets, and the front
 * market for the IV snapshot. Server-data only — renders for any visitor.
 */
import { useMemo } from 'react';
import { useFlow } from '@/lib/hooks/use-flow';
import { useMarketGrid } from '@/lib/hooks/use-market-grid';
import type { MarketCell } from '@/lib/analytics/market-grid';
import type { FlowEvent, Sentiment } from '@/lib/analytics/flow';

export interface AnalyticsKpis {
  /** DUSDC bet across live markets in the last hour. */
  totalBet: number;
  /** Count of live (tradeable) markets. */
  activeMarkets: number;
  /** UP share of recent staked dollars, [0,1]. */
  upShare: number;
  /** The single biggest bet in the recent window (DUSDC). */
  biggestBet: number;
}

export interface UseAnalyticsOverview {
  kpis: AnalyticsKpis;
  sentiment: Sentiment;
  /** Most active markets by money bet (desc). */
  hotMarkets: MarketCell[];
  /** Newest bets, freshest first. */
  recentFlow: FlowEvent[];
  /** Nearest-expiry live market — drives the IV snapshot. */
  frontMarket: MarketCell | null;
  loading: boolean;
}

const HOT_N = 6;
const RECENT_N = 7;

export function useAnalyticsOverview(): UseAnalyticsOverview {
  const { tape, sentiment, loading: flowLoading } = useFlow();
  const { cells, loading: gridLoading } = useMarketGrid();

  return useMemo(() => {
    const biggestBet = tape.reduce((m, f) => (f.kind === 'mint' && f.amount > m ? f.amount : m), 0);
    const hotMarkets = [...cells].sort((a, b) => b.volume - a.volume).slice(0, HOT_N);
    // cells come expiry-sorted from the grid fold → cells[0] is the nearest expiry.
    const frontMarket = cells[0] ?? null;

    return {
      kpis: {
        totalBet: sentiment.totalCost,
        activeMarkets: cells.length,
        upShare: sentiment.upShare,
        biggestBet,
      },
      sentiment,
      hotMarkets,
      recentFlow: tape.slice(0, RECENT_N),
      frontMarket,
      loading: flowLoading || gridLoading,
    };
  }, [tape, sentiment, cells, flowLoading, gridLoading]);
}
