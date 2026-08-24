/**
 * /v2/options — the BTC Options page. Same live snapshot as /v2 (active markets +
 * seeded pricers so the surface + ladder paint instantly), rendered into the
 * options-analysis layout: live surface, probability ladder, expected move, term
 * structure, and a reality check — every rung one click from a bet.
 */
import type { Metadata } from 'next';
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, wallClockMs } from '@/lib/markets/v2-discovery';
import { pickAcrossTenors } from '@/lib/insights';
import { simulateLivePricer, v2GrpcClient, type LivePricer } from '@/lib/sui/v2/pricer';
import { V2OptionsScreen } from '@/app/_components/v2/options/options-screen';
import { ErrorState } from '@/app/_components/ui/error-state';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

export const metadata: Metadata = {
  title: 'BTC Options',
  description: 'The clearest read on Bitcoin options — live volatility surface, probability ladder, expected move, and reality check.',
};

export const dynamic = 'force-dynamic';

export default async function V2OptionsPage() {
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

  // Seed the nearest 2 markets per TENOR BAND (≥2 expiries → a real surface) so the
  // surface + ladder paint instantly; the client refreshes per-market live.
  //
  // Banded by time left rather than by cadence on purpose. Seeding by cadence worked
  // only because the three cadences happened to be the three horizons — the day 1d
  // and 1w markets ship they both classify as '1h' (the classifier's `> 40min`
  // branch), so a whole horizon would go unseeded and the surface would open flat at
  // the long end. `pickAcrossTenors` reads `expiry − now`, so new tenors seed
  // correctly with no change here. See lib/insights/tenor.
  const seedTargets = pickAcrossTenors(markets, (m) => m.expiry, now, 2);
  const client = v2GrpcClient();
  const seedResults = await Promise.allSettled(seedTargets.map((m) => simulateLivePricer(client, m.expiry_market_id)));
  const pricerSeeds: Record<string, LivePricer> = {};
  seedTargets.forEach((m, i) => {
    const r = seedResults[i];
    if (r.status === 'fulfilled') pricerSeeds[m.expiry_market_id] = r.value;
  });

  return <V2OptionsScreen markets={markets} pricerSeeds={pricerSeeds} serverNow={now} />;
}
