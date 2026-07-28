/**
 * /v2/copilot — "talk to the surface". Same live snapshot as /v2 (active markets
 * + seeded pricers so the surface/ticket paint instantly), rendered into the
 * conversational V2CopilotScreen instead of the standard Trade layout.
 */
import type { Metadata } from 'next';
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, wallClockMs } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, type LivePricer } from '@/lib/sui/v2/pricer';
import { V2CopilotScreen } from '@/app/_components/v2/copilot/copilot-screen';
import { ErrorState } from '@/app/_components/ui/error-state';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

export const metadata: Metadata = {
  title: 'Ask Kelly',
  description: 'Ask about any market in plain words and get a ready-to-place trade.',
  openGraph: {
    type: 'website',
    title: 'Meet Kelly, the Predict AI Agent that reads the Surface',
    description: 'Ask about any market in plain words and get a ready-to-place trade.',
    images: [
      {
        url: '/ask-kelly-og-card.png',
        width: 1200,
        height: 630,
        alt: 'Kelly, the Skew Predict AI agent, reading the Surface',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Meet Kelly, the Predict AI Agent that reads the Surface',
    description: 'Ask about any market in plain words and get a ready-to-place trade.',
    images: ['/ask-kelly-og-card.png'],
  },
};

export const dynamic = 'force-dynamic';

export default async function V2CopilotPage() {
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
  // surface/ticket paint instantly; the client refreshes per-market live.
  const grouped = groupByCadence(markets);
  const seedTargets = CADENCE_ORDER.flatMap((c) => grouped[c].slice(0, 2)) as V2Market[];
  const client = v2GrpcClient();
  const seedResults = await Promise.allSettled(seedTargets.map((m) => simulateLivePricer(client, m.expiry_market_id)));
  const pricerSeeds: Record<string, LivePricer> = {};
  seedTargets.forEach((m, i) => {
    const r = seedResults[i];
    if (r.status === 'fulfilled') pricerSeeds[m.expiry_market_id] = r.value;
  });

  return <V2CopilotScreen markets={markets} pricerSeeds={pricerSeeds} serverNow={now} />;
}
