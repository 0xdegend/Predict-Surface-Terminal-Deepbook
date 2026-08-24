/**
 * /v2/risk — the Latest deployment's Vault Risk screen (legacy /risk role).
 *
 * Server-seeds the active market list for instant first paint; the client
 * V2RiskPanel takes over live (vault snapshot, per-market open interest, flush
 * history) and drives the gauges, share-price chart, and stress simulator.
 */
import type { Metadata } from 'next';
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, wallClockMs } from '@/lib/markets/v2-discovery';
import { V2RiskPanel } from '@/app/_components/v2/risk-panel';
import { ErrorState } from '@/app/_components/ui/error-state';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

export const metadata: Metadata = {
  title: 'Vault Risk',
  description:
    'How safe is the Skew liquidity pool? A live health check: how much is at work, how much you can withdraw now, how far it covers what it could owe, and a stress test for adverse settlements.',
};

export const dynamic = 'force-dynamic';

export default async function V2RiskPage() {
  let markets: V2Market[] = [];
  let error: string | null = null;

  try {
    const [marketRows, status] = await Promise.all([
      getV2Markets(100),
      getV2Status().catch(() => null),
    ]);
    markets = activeMarkets(marketRows, status?.current_time_ms ?? wallClockMs());
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

  return <V2RiskPanel initialMarkets={markets} />;
}
