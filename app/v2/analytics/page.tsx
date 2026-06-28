/**
 * /v2/analytics — market analytics for the new deployment.
 *
 * Deep analytics (flow tape, sentiment) need a trade-event feed the indexer
 * doesn't aggregate yet. This shows what IS readable live — active market counts
 * by cadence + spot — and notes the richer feed as coming.
 */
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, CADENCE_LABEL, wallClockMs } from '@/lib/markets/v2-discovery';
import { V2SpotTape } from '@/app/_components/v2/spot-tape';
import type { V2Market } from '@/lib/api/v2/types';

export const dynamic = 'force-dynamic';

export default async function V2AnalyticsPage() {
  let markets: V2Market[] = [];
  try {
    const [rows, status] = await Promise.all([getV2Markets(100), getV2Status().catch(() => null)]);
    markets = activeMarkets(rows, status?.current_time_ms ?? wallClockMs());
  } catch {
    /* fall through to empty */
  }
  const grouped = groupByCadence(markets);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Latest</p>
        <h1 className="text-[22px] font-semibold tracking-tight text-text-1">Analytics</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          Live market activity on the new release. Deeper flow &amp; sentiment analytics arrive once
          the trade feed is indexed.
        </p>
      </header>

      <div className="mb-6">
        <V2SpotTape />
      </div>

      <section className="panel p-4">
        <h2 className="mb-3 text-[14px] font-medium tracking-tight text-text-1">Active markets</h2>
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md">
          {CADENCE_ORDER.map((c) => (
            <div key={c} className="bg-white/2 px-3 py-3">
              <div className="eyebrow mb-0.5">{CADENCE_LABEL[c]}</div>
              <div className="font-mono text-[18px] tabular-nums text-text-1">{grouped[c].length}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-text-3">{markets.length} live markets across all cadences.</p>
      </section>
    </main>
  );
}
