/**
 * /v2 — the Latest deployment's Trade screen.
 *
 * Server fetches the live active markets + simulates a pricer for the nearest
 * market in each cadence (instant first paint); the client V2TradeScreen takes
 * over live (picker ↔ ticket ↔ odds via the shared store, per-market Pricer).
 */
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, wallClockMs } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, type LivePricer } from '@/lib/sui/v2/pricer';
import { V2TradeScreen } from '@/app/_components/v2/trade-screen';
import { ErrorState } from '@/app/_components/ui/error-state';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

export const dynamic = 'force-dynamic';

export default async function V2Page() {
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
        note="Usually a transient network hiccup — retry in a moment."
      />
    );
  }

  // Seed the nearest 2 markets per cadence (≥2 expiries → a real surface) so the
  // smile/odds/surface paint instantly; the client refreshes per-market live.
  const grouped = groupByCadence(markets);
  const seedTargets = CADENCE_ORDER.flatMap((c) => grouped[c].slice(0, 2)) as V2Market[];
  const client = v2GrpcClient();
  const seedResults = await Promise.allSettled(seedTargets.map((m) => simulateLivePricer(client, m.expiry_market_id)));
  const pricerSeeds: Record<string, LivePricer> = {};
  seedTargets.forEach((m, i) => {
    const r = seedResults[i];
    if (r.status === 'fulfilled') pricerSeeds[m.expiry_market_id] = r.value;
  });

  return <V2TradeScreen markets={markets} pricerSeeds={pricerSeeds} serverNow={now} />;
}
