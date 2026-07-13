/**
 * /v2/analytics — market analytics for the new deployment, mirroring the legacy
 * Analytics screen (tabbed: Pulse · Markets · Sentiment · Price swings · Live
 * bets). This server route seeds the REAL inputs — the live market list and
 * network time from the indexer, plus live BTC spot from the propbook oracle —
 * and hands them to the client panel. The panel takes over live: it fans the
 * per-market order + activity feeds and the live pricer out across the active
 * markets to reconstruct the whole book's volume, sentiment, flow and implied vol
 * (there is no global flow endpoint). See useV2Analytics.
 */
import { getV2Markets, getV2Status, getPythLatest, pythSpot } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import { activeMarkets, wallClockMs } from '@/lib/markets/v2-discovery';
import { V2AnalyticsPanel } from '@/app/_components/v2/analytics/panel';
import type { V2Market } from '@/lib/api/v2/types';

export const dynamic = 'force-dynamic';

export default async function V2AnalyticsPage() {
  let markets: V2Market[] = [];
  let now = wallClockMs();
  let spot: number | null = null;

  try {
    const [rows, status, pyth] = await Promise.all([
      getV2Markets(100),
      getV2Status().catch(() => null),
      getPythLatest(predictV2Config.asset.pythFeedId).catch(() => null),
    ]);
    now = status?.current_time_ms ?? now;
    spot = pythSpot(pyth ?? null);
    markets = activeMarkets(rows, now);
  } catch {
    /* fall through to empty — the panel handles no markets */
  }

  return (
    <main className="flex flex-1 flex-col">
      <V2AnalyticsPanel markets={markets} spot={spot} />
    </main>
  );
}
