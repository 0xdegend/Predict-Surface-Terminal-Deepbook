'use client';

/**
 * V2TradeScreen — the new-deployment Trade screen, mirroring the legacy layout:
 * left = hero (live smile) + market picker; right rail = trade ticket + market
 * odds + positions. A shared store (v2-trade-store) bridges picker ↔ ticket ↔
 * odds; the selected market's live Pricer drives the smile, odds, and quote.
 *
 * Responsive ticket (legacy parity): desktop shows the ticket in the right rail
 * (V2TicketRail); mobile moves it into a slide-up bottom sheet (V2TradeSheet)
 * that opens on any market pick, so it isn't buried under a long scroll. Both
 * are useMediaQuery-gated, so exactly one ticket mounts per breakpoint.
 */
import { useEffect, useMemo, useState } from 'react';
import { LuBoxes, LuChartArea } from 'react-icons/lu';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useNow } from '@/lib/hooks/use-now';
import { V2MarketPicker } from './market-picker';
import { V2TicketRail, V2TradeSheet } from './trade-sheet';
import { V2PriceChart } from './price-chart';
import { V2PositionsPanel } from './positions-panel';
import { V2RailTabs } from './rail-tabs';
import { SurfaceMountV2 } from './surface/surface-mount';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

type HeroView = 'surface' | 'chart';

export function V2TradeScreen({
  markets: initialMarkets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  // Live market discovery — the server snapshot goes stale fast (a new
  // 1-minute market opens every minute), so poll and let fresh markets flow
  // into the picker/table/ticket without a reload.
  const markets = useV2Markets(initialMarkets);
  const marketId = useV2TradeStore((s) => s.marketId);
  // Auto-advance to the next market as expiries roll is handled by the
  // per-second <MarketAutoAdvancer> below (legacy useFrontOracleId parity).

  const selected = markets.find((m) => m.expiry_market_id === marketId) ?? markets[0] ?? null;
  const { data: pricer } = useV2Pricer(selected?.expiry_market_id ?? null, selected ? pricerSeeds[selected.expiry_market_id] : undefined);

  // LIVE pricers for every active market (bounded: ~3 per cadence), seeded from
  // the server snapshot and shared with the picker's cache. The surface must NOT
  // be built off the static `pricerSeeds`: markets roll every minute, so a
  // page-load snapshot decays (rows vanish as seeds expire, new markets never
  // join, and each surviving row's SVI/forward stays frozen) — the "live"
  // surface was neither live nor whole after a few minutes.
  const marketIds = useMemo(() => markets.map((m) => m.expiry_market_id), [markets]);
  // 5s (not the 20s default): this poll is also what the surface's SVI tape records
  // (lib/surface/v2-svi-tape.ts), and the tape's resolution IS the time-travel
  // scrub's resolution — at 20s a 4-minute rewind would be a dozen coarse steps.
  // It doubles as a livelier surface. Bounded: only the handful of active markets.
  const pricers = useV2Pricers(marketIds, pricerSeeds, 5_000);

  // Surface inputs from the live pricers (≥2 expiries needed to form a surface).
  // buildSurface only reads oracle_id/expiry/underlying_asset, so a minimal cast is safe.
  const surfaceInputs = useMemo<SmileInput[]>(
    () =>
      markets.flatMap((m) => {
        const p = pricers[m.expiry_market_id];
        return p
          ? [{ oracle: { oracle_id: m.expiry_market_id, expiry: m.expiry, underlying_asset: 'BTC' } as unknown as Oracle, svi: p.svi, forward: p.forward }]
          : [];
      }),
    [markets, pricers],
  );

  if (markets.length === 0) {
    return <div className="card mx-4 my-8 px-4 py-8 text-center text-[13px] text-text-3">No live markets right now — check back in a moment.</div>;
  }

  return (
    <>
    {/* Keeps the selection on a live market — advances the instant one expires. */}
    <MarketAutoAdvancer markets={markets} serverNow={serverNow} />
    <main className="rise grid flex-1 grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
      {/* left — hero + picker. Hero is full-bleed (no card/padding), framed only
          by the grid hairlines — mirrors legacy's edge-to-edge MarketView. */}
      <section className="flex min-w-0 flex-col gap-px bg-white/6">
        <div data-tour="surface" className="h-[48vh] min-h-90 bg-bg-0 md:h-[56vh] lg:h-[64vh] lg:min-h-130">
          {selected && (
            <Hero market={selected} pricer={pricer} serverNow={serverNow} surfaceInputs={surfaceInputs} markets={markets} />
          )}
        </div>
        <div data-tour="picker" className="flex min-h-0 flex-1 flex-col bg-bg-0 p-4 sm:p-5">
          <V2MarketPicker markets={markets} pricerSeeds={pricerSeeds} serverNow={serverNow} />
        </div>
      </section>

      {/* right rail. Desktop: trade ticket on top, market odds + positions
          underneath. On mobile the ticket lives in the slide-up V2TradeSheet, so
          the rail is just odds + positions (the ticket block hides at <lg). */}
      <aside className="flex min-w-0 flex-col gap-6 bg-bg-0 p-4 sm:p-5">
        <div data-tour="ticket" className="hidden flex-col gap-4 lg:flex">
          {/* Rail ticket heading — mirrors legacy's TicketTitle chrome. */}
          <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
            <span className="h-3 w-px bg-accent/70" />
            Trade ticket · click surface → mint
          </h2>
          <V2TicketRail market={selected} pricer={pricer} serverNow={serverNow} />
        </div>
        {/* Odds ⇆ Analysis. Odds is the surface's own fair-probability curve;
            Analysis is the wider-market (Clawby) read + the picked strike's
            real-world stats. Analysis is mount-gated inside, so its data only
            loads when a trader opens that tab. */}
        <div className="lg:border-t lg:border-line lg:pt-5">
          <V2RailTabs market={selected} pricer={pricer} serverNow={serverNow} />
        </div>
        <div className="lg:border-t lg:border-line lg:pt-5">
          <V2PositionsPanel />
        </div>
      </aside>
    </main>

    {/* Mobile trade ticket — slides up over the page when a market is picked.
        Renders nothing on desktop (the rail ticket takes over). */}
    <V2TradeSheet market={selected} pricer={pricer} serverNow={serverNow} />
    </>
  );
}

/**
 * Keep the active market on the soonest one — legacy parity with the
 * `selection ?? front` model (useFrontOracleId). Time-driven (useNow,
 * per-second): with no explicit pick, the selection TRACKS the soonest open
 * market (the top of the soonest-first list), so it never drifts down as newer,
 * sooner markets open above a longer-dated one. An explicit user pick (pinned)
 * is honored until it expires, then it falls back to auto-following the soonest.
 * Isolated in a null component so only IT re-renders each second, not the whole
 * hero/chart/surface tree.
 */
function MarketAutoAdvancer({ markets, serverNow }: { markets: V2Market[]; serverNow: number }) {
  const now = useNow(serverNow);
  const marketId = useV2TradeStore((s) => s.marketId);
  const marketPinned = useV2TradeStore((s) => s.marketPinned);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  useEffect(() => {
    if (markets.length === 0) return;
    // Soonest still-open market — the head of the (soonest-first) list.
    const soonest = markets.find((m) => m.expiry > now);
    if (!soonest) return; // nothing open right now — leave the selection be
    // Honor a still-live explicit pick; otherwise (auto, or the pick expired)
    // snap to the soonest. selectMarket(_, false) re-marks it as auto, and the
    // `!== marketId` guard keeps it a no-op once already on the soonest.
    const current = markets.find((m) => m.expiry_market_id === marketId);
    if (marketPinned && current && current.expiry > now) return;
    if (soonest.expiry_market_id !== marketId) selectMarket(soonest.expiry_market_id, false);
  }, [markets, marketId, marketPinned, now, selectMarket]);
  return null;
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
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const canSurface = surfaceInputs.length >= 2;
  const [override, setOverride] = useState<HeroView | null>(null);
  // Default to the 3-D surface on desktop, the lighter live chart on mobile.
  const wanted: HeroView = override ?? (canSurface && isDesktop ? 'surface' : 'chart');
  const view: HeroView = wanted === 'surface' && !canSurface ? 'chart' : wanted;

  return (
    <div className="relative h-full w-full">
      {/* Floating segmented view toggle over the canvas — mirrors legacy's
          MarketView (gliding-thumb, top-left) so both deployments feel identical.
          Market / settles-in / forward aren't repeated here: the countdown is in
          the ticket beside it, the forward on the surface + nav tape. */}
      <div className="pointer-events-auto absolute left-3 top-3 z-20">
        <div className="segmented" role="tablist" aria-label="Market view">
          <span
            aria-hidden
            className="segmented-thumb"
            style={{ transform: view === 'chart' ? 'translateX(100%)' : 'translateX(0)' }}
          />
          <ViewTab Icon={LuBoxes} label="Surface" active={view === 'surface'} onClick={() => setOverride('surface')} disabled={!canSurface} />
          <ViewTab Icon={LuChartArea} label="Chart" active={view === 'chart'} onClick={() => setOverride('chart')} />
        </div>
      </div>

      {view === 'surface' ? (
        <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} />
      ) : (
        <V2PriceChart market={market} pricer={pricer} />
      )}
    </div>
  );
}

function ViewTab({
  Icon,
  label,
  active,
  onClick,
  disabled,
}: {
  Icon: typeof LuBoxes;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2'
      }`}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

