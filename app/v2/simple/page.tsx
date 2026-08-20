/**
 * /v2/simple — the Latest deployment's SIMPLE trade screen (UP/DOWN rounds).
 *
 * Same server seeding as /v2 (active markets + a pricer per nearest market) plus
 * the per-market STATE for the nearest market of each cadence, so the round's
 * pinned line paints immediately instead of flashing at-the-money while the state
 * read lands. The client SimpleScreen takes over live. See [[simple-mode]].
 *
 * The route itself honours `V2_SIMPLE_ENABLED` and redirects to the full terminal when
 * simple mode is off. Without this the flag only hid the WAY IN: every nav href and
 * toggle checked it, but the page still rendered for anyone who typed the URL, kept a
 * bookmark, or had 'simple' persisted in their trade-view store from a previous release
 * — so a kill switch thrown after a bad deploy would not actually have taken the screen
 * down. Server-side, so nothing of it ships to a client that shouldn't have it.
 */
import { redirect } from 'next/navigation';
import { getV2Markets, getV2Status, getV2MarketState } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, wallClockMs } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, type LivePricer } from '@/lib/sui/v2/pricer';
import { SimpleScreen } from '@/app/_components/v2/simple/simple-screen';
import { ErrorState } from '@/app/_components/ui/error-state';
import { predictV2Config, V2_SIMPLE_ENABLED } from '@/config/predict';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';

export const dynamic = 'force-dynamic';

export default async function V2SimplePage() {
  if (!V2_SIMPLE_ENABLED) redirect('/v2');

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

  const grouped = groupByCadence(markets);
  // Seed the nearest 2 markets per cadence for the pricer (instant odds), and the
  // nearest 1 per cadence for the market state (the pinned line).
  const client = v2GrpcClient();
  const pricerTargets = CADENCE_ORDER.flatMap((c) => grouped[c].slice(0, 2)) as V2Market[];
  const stateTargets = CADENCE_ORDER.map((c) => grouped[c][0]).filter(Boolean) as V2Market[];

  const [pricerResults, stateResults] = await Promise.all([
    Promise.allSettled(pricerTargets.map((m) => simulateLivePricer(client, m.expiry_market_id))),
    Promise.allSettled(stateTargets.map((m) => getV2MarketState(m.expiry_market_id))),
  ]);

  const pricerSeeds: Record<string, LivePricer> = {};
  pricerTargets.forEach((m, i) => {
    const r = pricerResults[i];
    if (r.status === 'fulfilled') pricerSeeds[m.expiry_market_id] = r.value;
  });
  const stateSeeds: Record<string, V2MarketState> = {};
  stateTargets.forEach((m, i) => {
    const r = stateResults[i];
    if (r.status === 'fulfilled') stateSeeds[m.expiry_market_id] = r.value;
  });

  return <SimpleScreen markets={markets} pricerSeeds={pricerSeeds} stateSeeds={stateSeeds} serverNow={now} />;
}
