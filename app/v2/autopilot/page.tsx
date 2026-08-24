/**
 * /v2/autopilot — Kelly's Autopilot cockpit. Same live snapshot as /v2/copilot
 * (active markets + seeded pricers), rendered into the AutopilotPanel so the
 * engine can start pricing the moment the page paints.
 */
import type { Metadata } from 'next';
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, wallClockMs } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, type LivePricer } from '@/lib/sui/v2/pricer';
import { AutopilotPanel } from '@/app/_components/v2/autopilot/autopilot-panel';
import { ErrorState } from '@/app/_components/ui/error-state';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

export const metadata: Metadata = {
  title: 'Autopilot',
  description: 'Let Kelly place her best-value bets for you, within the rules and budget you set.',
};

export const dynamic = 'force-dynamic';

export default async function V2AutopilotPage() {
  let markets: V2Market[] = [];
  let now = wallClockMs();
  let error: string | null = null;

  try {
    const [marketRows, status] = await Promise.all([getV2Markets(100), getV2Status().catch(() => null)]);
    now = status?.current_time_ms ?? now;
    markets = activeMarkets(marketRows, now);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <ErrorState
        title="Couldn’t reach the Predict server"
        message={error}
        detail={predictV2Config.serverUrl}
        note="Usually a transient network hiccup. Retry in a moment."
      />
    );
  }

  // Seed the nearest 2 markets per cadence so pricing is warm on first paint;
  // the client refreshes each market live from there.
  const grouped = groupByCadence(markets);
  const seedTargets = CADENCE_ORDER.flatMap((c) => grouped[c].slice(0, 2)) as V2Market[];
  const client = v2GrpcClient();
  const seedResults = await Promise.allSettled(seedTargets.map((m) => simulateLivePricer(client, m.expiry_market_id)));
  const pricerSeeds: Record<string, LivePricer> = {};
  seedTargets.forEach((m, i) => {
    const r = seedResults[i];
    if (r.status === 'fulfilled') pricerSeeds[m.expiry_market_id] = r.value;
  });

  return <AutopilotPanel markets={markets} pricerSeeds={pricerSeeds} />;
}
