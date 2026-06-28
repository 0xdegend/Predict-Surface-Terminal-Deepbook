'use client';

/**
 * V2TradeScreen — the new-deployment Trade screen, mirroring the legacy layout:
 * left = hero (live smile) + market picker; right rail = trade ticket + market
 * odds + positions. A shared store (v2-trade-store) bridges picker ↔ ticket ↔
 * odds; the selected market's live Pricer drives the smile, odds, and quote.
 *
 * Mobile stacks the rail under the markets (the legacy slide-up sheet is a UI-6
 * polish item). Positions are a placeholder until UI-3.
 */
import { useEffect, useMemo, useState } from 'react';
import { LuBoxes, LuChartArea } from 'react-icons/lu';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useNow } from '@/lib/hooks/use-now';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { cadenceOf, CADENCE_LABEL } from '@/lib/markets/v2-discovery';
import { V2MarketPicker } from './market-picker';
import { V2TradeTicket } from './trade-ticket';
import { V2OddsPanel } from './odds-panel';
import { V2PriceChart } from './price-chart';
import { SurfaceMountV2 } from './surface/surface-mount';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

type HeroView = 'surface' | 'chart';

export function V2TradeScreen({
  markets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  const marketId = useV2TradeStore((s) => s.marketId);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);

  // Default to the soonest market; re-select if the current one expired off-list.
  useEffect(() => {
    if (markets.length === 0) return;
    if (!marketId || !markets.some((m) => m.expiry_market_id === marketId)) {
      selectMarket(markets[0].expiry_market_id);
    }
  }, [marketId, markets, selectMarket]);

  const selected = markets.find((m) => m.expiry_market_id === marketId) ?? markets[0] ?? null;
  const { data: pricer } = useV2Pricer(selected?.expiry_market_id ?? null, selected ? pricerSeeds[selected.expiry_market_id] : undefined);

  // Surface inputs from the seeded markets (≥2 expiries needed to form a surface).
  // buildSurface only reads oracle_id/expiry/underlying_asset, so a minimal cast is safe.
  const surfaceInputs = useMemo<SmileInput[]>(
    () =>
      markets.flatMap((m) => {
        const p = pricerSeeds[m.expiry_market_id];
        return p
          ? [{ oracle: { oracle_id: m.expiry_market_id, expiry: m.expiry, underlying_asset: 'BTC' } as unknown as Oracle, svi: p.svi, forward: p.forward }]
          : [];
      }),
    [markets, pricerSeeds],
  );

  if (markets.length === 0) {
    return <div className="card mx-4 my-8 px-4 py-8 text-center text-[13px] text-text-3">No live markets right now — check back in a moment.</div>;
  }

  return (
    <main className="rise grid flex-1 grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
      {/* left — hero + picker */}
      <section className="flex min-w-0 flex-col gap-px bg-white/6">
        <div className="bg-bg-0 p-4 sm:p-5">
          {selected && (
            <Hero market={selected} pricer={pricer} serverNow={serverNow} surfaceInputs={surfaceInputs} markets={markets} />
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col bg-bg-0 p-4 sm:p-5">
          <V2MarketPicker markets={markets} serverNow={serverNow} />
        </div>
      </section>

      {/* right rail */}
      <aside className="flex min-w-0 flex-col gap-6 bg-bg-0 p-4 sm:p-5">
        <V2TradeTicket market={selected} pricer={pricer} />
        {selected && (
          <div className="lg:border-t lg:border-line lg:pt-5">
            <V2OddsPanel market={selected} pricer={pricer} />
          </div>
        )}
        <div className="lg:border-t lg:border-line lg:pt-5">
          <h3 className="mb-1 text-[13px] font-medium tracking-tight text-text-1">Your positions</h3>
          <p className="text-[11px] leading-relaxed text-text-3">Open a position and it’ll show here. (Full portfolio coming next.)</p>
        </div>
      </aside>
    </main>
  );
}

function Hero({
  market,
  pricer,
  serverNow,
  surfaceInputs,
  markets,
}: {
  market: V2Market;
  pricer?: LivePricer;
  serverNow: number;
  surfaceInputs: SmileInput[];
  markets: V2Market[];
}) {
  const now = useNow(serverNow);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const canSurface = surfaceInputs.length >= 2;
  const [override, setOverride] = useState<HeroView | null>(null);
  // Default to the 3-D surface on desktop, the lighter live chart on mobile.
  const wanted: HeroView = override ?? (canSurface && isDesktop ? 'surface' : 'chart');
  const view: HeroView = wanted === 'surface' && !canSurface ? 'chart' : wanted;

  const secs = Math.max(0, Math.round((market.expiry - now) / 1000));
  const cd = secs < 3600 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 p-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <Field label="Market" value={CADENCE_LABEL[cadenceOf(market)]} />
          <Field label="Settles in" value={cd} mono />
          <Field label="Forward" value={pricer ? `$${pricer.forward.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} mono />
        </div>
        <div className="flex items-center gap-0.5 rounded-lg bg-white/2 p-0.5">
          <ViewBtn active={view === 'surface'} onClick={() => setOverride('surface')} Icon={LuBoxes} label="Surface" disabled={!canSurface} />
          <ViewBtn active={view === 'chart'} onClick={() => setOverride('chart')} Icon={LuChartArea} label="Chart" />
        </div>
      </div>

      <div className="h-[44vh] min-h-75 w-full">
        {view === 'surface' ? <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} /> : <V2PriceChart />}
      </div>
    </div>
  );
}

function ViewBtn({
  active,
  onClick,
  Icon,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  Icon: typeof LuBoxes;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="eyebrow mr-2">{label}</span>
      <span className={`text-[13px] text-text-1 ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</span>
    </div>
  );
}
