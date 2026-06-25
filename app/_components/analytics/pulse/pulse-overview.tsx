'use client';

/**
 * PulseOverview — the Analytics landing dashboard: a bento of live, glance-able
 * widgets so the whole market reads at once. Desktop layout is a fixed-height
 * hero (hottest markets on the left; crowd mood + price-swing snapshot stacked
 * on the right, so the right column aligns to the hero height) with the live bet
 * feed spanning full width below. Composes the shared spines — no new fetches.
 */
import { useAnalyticsOverview } from '@/lib/hooks/use-analytics-overview';
import { KpiStrip } from './kpi-strip';
import { HotMarkets } from './hot-markets';
import { LiveTicker } from './live-ticker';
import { IvSnapshot } from './iv-snapshot';
import { PulseSkeleton } from './pulse-skeleton';
import { SentimentGauge } from '../sentiment-gauge';

export function PulseOverview() {
  const { kpis, sentiment, hotMarkets, recentFlow, frontMarket, loading } = useAnalyticsOverview();

  // First paint (nothing fetched yet) → a full-page skeleton in the bento shape,
  // so the layout never jumps as data fills in.
  if (loading && hotMarkets.length === 0 && recentFlow.length === 0) return <PulseSkeleton />;

  return (
    <div className="space-y-3">
      <KpiStrip kpis={kpis} loading={loading} />

      {/* Hero — fixed height on desktop so both columns align exactly. */}
      <div className="grid gap-3 lg:h-100 lg:grid-cols-3">
        <div className="lg:col-span-2 lg:h-full">
          <HotMarkets markets={hotMarkets} loading={loading} className="h-full" />
        </div>
        <div className="flex flex-col gap-3 lg:col-span-1 lg:h-full">
          <SentimentGauge sentiment={sentiment} className="min-h-0 flex-1" />
          <IvSnapshot market={frontMarket} className="min-h-0 flex-1" />
        </div>
      </div>

      {/* Live feed — full width below the hero. */}
      <LiveTicker flow={recentFlow} loading={loading} />
    </div>
  );
}
