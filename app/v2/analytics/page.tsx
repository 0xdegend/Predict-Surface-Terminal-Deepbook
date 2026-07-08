/**
 * /v2/analytics — market analytics for the new deployment.
 *
 * Live from the indexer (endpoints shipped ~2026-07): per-market open interest
 * and hourly activity/liquidation stats, rolled up here across the currently
 * live markets (a bounded fan-out — markets roll fast, so "since open" for the
 * short cadences is minutes, not days). A GLOBAL trade tape (all-market flow &
 * sentiment, legacy-style /positions/minted) still isn't indexed — that part
 * stays "coming".
 */
import {
  getV2Markets,
  getV2Status,
  getMarketOpenInterest,
  getMarketActivity,
  getMarketLiquidationStats,
} from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, CADENCE_LABEL, wallClockMs } from '@/lib/markets/v2-discovery';
import { V2SpotTape } from '@/app/_components/v2/spot-tape';
import { fromQuote } from '@/config/scale';
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

  // Bounded fan-out over the live markets only (~3 per cadence). allSettled so
  // one flaky market read never blanks the page.
  const [oiRes, actRes, liqRes] = await Promise.all([
    Promise.allSettled(markets.map((m) => getMarketOpenInterest(m.expiry_market_id))),
    Promise.allSettled(markets.map((m) => getMarketActivity(m.expiry_market_id))),
    Promise.allSettled(markets.map((m) => getMarketLiquidationStats(m.expiry_market_id))),
  ]);
  const oi = oiRes.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const acts = actRes.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const liqs = liqRes.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  const openOrders = oi.reduce((s, r) => s + r.open_order_count, 0);
  const openPayout = fromQuote(oi.reduce((s, r) => s + Number(r.open_quantity), 0));
  const mints = acts.reduce((s, a) => s + a.mint_count, 0);
  const staked = fromQuote(acts.reduce((s, a) => s + Number(a.mint_premium), 0));
  const fees = fromQuote(
    acts.reduce((s, a) => s + Number(a.mint_fees) + Number(a.live_redeem_fees), 0),
  );
  const redeems = acts.reduce((s, a) => s + a.live_redeem_count + a.settled_redeem_count, 0);
  const liqCount = liqs.reduce((s, l) => s + l.liquidated_count, 0);
  const quiet = openOrders === 0 && mints === 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Latest</p>
        <h1 className="text-[22px] font-semibold tracking-tight text-text-1">Analytics</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          Live open interest and trading activity in the markets that are open right now. The
          all-market flow tape &amp; sentiment feed arrives once the indexer aggregates the global
          trade history.
        </p>
      </header>

      <div className="mb-6">
        <V2SpotTape />
      </div>

      <div className="flex flex-col gap-6">
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

        <section className="panel p-4">
          <h2 className="mb-3 text-[14px] font-medium tracking-tight text-text-1">Open interest</h2>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md">
            <Tile label="Open positions" value={fmtCount(openOrders)} sub="across live markets" />
            <Tile label="Payout at stake" value={`$${fmtUsd(openPayout)}`} sub="max payout of open positions" />
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="mb-3 text-[14px] font-medium tracking-tight text-text-1">
            Trading in live markets
          </h2>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md sm:grid-cols-4">
            <Tile label="Bets placed" value={fmtCount(mints)} sub="mints" />
            <Tile label="Staked" value={`$${fmtUsd(staked)}`} sub="net premium" />
            <Tile label="Cash-outs" value={fmtCount(redeems)} sub="live + settled" />
            <Tile label="Knockouts" value={fmtCount(liqCount)} sub={`fees $${fmtUsd(fees)}`} />
          </div>
          <p className="mt-3 text-[11px] text-text-3">
            {quiet
              ? 'Quiet right now — totals update as trades land in the open markets.'
              : 'Totals cover each live market since it opened; short-cadence markets roll every few minutes.'}
          </p>
        </section>
      </div>
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white/2 px-3 py-3">
      <div className="eyebrow mb-0.5">{label}</div>
      <div className="font-mono text-[18px] tabular-nums text-text-1">{value}</div>
      <div className="mt-0.5 text-[10px] text-text-3">{sub}</div>
    </div>
  );
}

function fmtCount(n: number): string {
  return n.toLocaleString();
}

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
