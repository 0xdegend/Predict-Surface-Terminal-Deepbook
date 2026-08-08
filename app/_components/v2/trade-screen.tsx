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
import Link from 'next/link';
import { LuBoxes, LuChartArea, LuGift, LuPause, LuSparkles } from 'react-icons/lu';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useBtcInsights } from '@/lib/hooks/use-btc-insights';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useNow } from '@/lib/hooks/use-now';
import { usePredictAccountV2, qkV2Account } from '@/lib/hooks/use-predict-account-v2';
import { useStarterGrant } from '@/lib/hooks/use-starter-grant';
import { starterGrant, STARTER_GRANT_BALANCE_CEILING } from '@/config/starter-grant';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import { V2MarketPicker } from './market-picker';
import { V2TicketRail, V2TradeSheet } from './trade-sheet';
import { V2PriceChart } from './price-chart';
import { V2PositionsPanel } from './positions-panel';
import { V2RailTabs } from './rail-tabs';
import { SessionPanel } from './session/session-panel';
import { SessionPill } from './session/session-pill';
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

  // "Paused" = no live markets right now (useV2Markets already returns only
  // active/future ones). We DON'T dead-end the page: the Pyth spot feed stays
  // live even when the protocol's market scheduler is off, so the hero keeps a
  // live BTC chart, the Surface tab disables itself (no vol feed without
  // markets), and the ticket blurs behind a "paused" note carrying live fear &
  // greed. Everything flips back to live automatically when markets return —
  // `paused` just goes false and the normal surface/ticket/picker light up.
  const paused = markets.length === 0;

  return (
    <>
    {/* Keeps the selection on a live market — advances the instant one expires. */}
    <MarketAutoAdvancer markets={markets} serverNow={serverNow} />
    {/* Mobile-only funding prompt: on desktop the ticket rail shows the starter
        grant on connect, but on mobile the ticket is a closed sheet, so a fresh
        empty wallet would never see it. Surface the same one-tap grant up here. */}
    <MobileFundBanner />
    <main className="rise grid flex-1 grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
      {/* left — hero + picker. Hero is full-bleed (no card/padding), framed only
          by the grid hairlines — mirrors legacy's edge-to-edge MarketView. */}
      <section className="flex min-w-0 flex-col gap-px bg-white/6">
        <div data-tour="surface" className="h-[48vh] min-h-90 bg-bg-0 md:h-[56vh] lg:h-[64vh] lg:min-h-130">
          <Hero market={selected} pricer={pricer} serverNow={serverNow} surfaceInputs={surfaceInputs} markets={markets} paused={paused} />
        </div>
        <div data-tour="picker" className="flex min-h-0 flex-1 flex-col bg-bg-0 p-4 sm:p-5">
          {paused ? <PickerPaused /> : <V2MarketPicker markets={markets} pricerSeeds={pricerSeeds} serverNow={serverNow} />}
        </div>
      </section>

      {/* right rail. Desktop: trade ticket on top, market odds + positions
          underneath. On mobile the ticket lives in the slide-up V2TradeSheet, so
          the rail is just odds + positions (the ticket block hides at <lg). */}
      <aside className="flex min-w-0 flex-col gap-6 bg-bg-0 p-4 sm:p-5">
        {/* Instant-trading (delegated session) control. Self-hides unless it's on
            for this build and the wallet benefits (Slush, funded account). */}
        <SessionPanel />
        {paused ? (
          // Paused: the ticket has nothing to quote, so blur it and surface the
          // live BTC fear & greed + a hand-off to Kelly (who still reads BTC).
          <PausedTicket />
        ) : (
          <>
            <div data-tour="ticket" className="hidden flex-col gap-4 lg:flex">
              {/* Rail ticket heading — mirrors legacy's TicketTitle chrome. */}
              <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
                <span className="h-3 w-px bg-accent/70" />
                Trade ticket · click surface → mint
                <span className="ml-auto normal-case">
                  <SessionPill />
                </span>
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
          </>
        )}
        <div className={paused ? '' : 'lg:border-t lg:border-line lg:pt-5'}>
          <V2PositionsPanel />
        </div>
      </aside>
    </main>

    {/* Mobile trade ticket — slides up over the page when a market is picked.
        Renders nothing on desktop (the rail ticket takes over), and nothing while
        paused (there's no market to pick). */}
    {!paused && <V2TradeSheet market={selected} pricer={pricer} serverNow={serverNow} />}
    </>
  );
}

/**
 * MobileFundBanner — a mobile-only "get funded" prompt for the Trade screen.
 *
 * The funding CTA normally lives at the top of the trade ticket, which on desktop
 * is the always-visible right rail. On mobile the ticket is a slide-up sheet that
 * only opens once a market is picked, so a freshly-connected empty wallet never sees
 * it. This surfaces the SAME one-tap starter grant (same route / treasury / gate as
 * the ticket) in a persistent banner above the layout, so a new trader can fund right
 * away without first opening the sheet. Hidden on desktop (`lg:hidden`) and once the
 * wallet has a trading account or any funds.
 */
function MobileFundBanner() {
  const acct = usePredictAccountV2();
  // The SAME one-tap grant the ticket uses: gasless (DUSDC only) for Enoki/Google,
  // plus gas SUI for external wallets; refetch the v2 wallet balance so this clears.
  const grant = useStarterGrant(acct.owner ?? null, !acct.gasless, {
    invalidateKeys: acct.owner ? [qkV2Account.walletDusdc(acct.owner)] : [],
    symbol: predictV2Config.quote.symbol,
  });

  // Offer to any connected wallet that's broke across account + wallet. NOT gated
  // on "no trading account yet": a wallet can create a free gasless account and
  // still have zero DUSDC (that exact case was hiding this banner). The server
  // self-heals stale markers, so a genuinely empty wallet claims; a really-funded
  // one falls back to the faucet. Mirrors the ticket's grantCta gate exactly.
  const eligible =
    !!acct.owner &&
    acct.walletDusdcBase !== undefined &&
    acct.balanceBase + acct.walletDusdcBase < STARTER_GRANT_BALANCE_CEILING &&
    !grant.success;

  if (!eligible) return null;

  const sym = predictV2Config.quote.symbol;

  return (
    <div className="border-b border-line bg-(--accent-soft) px-4 py-2.5 lg:hidden">
      {starterGrant.enabled && !grant.failed ? (
        <button
          type="button"
          onClick={grant.claim}
          disabled={grant.busy}
          className="flex w-full items-center justify-between gap-3 text-left text-[12px] font-medium text-accent disabled:opacity-60"
        >
          <span className="inline-flex items-center gap-2">
            <LuGift size={14} className="shrink-0" />
            {grant.busy
              ? 'Funding your account…'
              : `New here? Get ${fmtQuote(fromQuote(starterGrant.displayBase))} ${sym} to start trading`}
          </span>
          {!grant.busy && <span aria-hidden>→</span>}
        </button>
      ) : predictV2Config.faucetUrl ? (
        <a
          href={predictV2Config.faucetUrl}
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-between gap-3 text-[12px] font-medium text-accent"
        >
          <span className="inline-flex items-center gap-2">
            <LuGift size={14} className="shrink-0" />
            Low balance. Get testnet {sym}
          </span>
          <span aria-hidden>→</span>
        </a>
      ) : null}
    </div>
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
  paused,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
  surfaceInputs: SmileInput[];
  markets: V2Market[];
  paused: boolean;
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  // No live markets → no vol feed to build a surface from, so the Surface tab
  // disables itself and the hero holds the live price chart (Pyth keeps ticking).
  const canSurface = !paused && surfaceInputs.length >= 2;
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
          <ViewTab
            Icon={LuBoxes}
            label="Surface"
            active={view === 'surface'}
            onClick={() => setOverride('surface')}
            disabled={!canSurface}
            title={paused ? 'The surface is paused while markets are offline' : undefined}
          />
          <ViewTab Icon={LuChartArea} label="Chart" active={view === 'chart'} onClick={() => setOverride('chart')} />
        </div>
      </div>

      {/* Honest "paused" flag so the empty ticket + missing surface read as an
          upstream pause, not a broken page. */}
      {paused && (
        <div className="pointer-events-none absolute right-3 top-3 z-20">
          <span className="chip h-6 gap-1.5 px-2.5 text-[10px] uppercase tracking-wider text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            Markets paused
          </span>
        </div>
      )}

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
  title,
}: {
  Icon: typeof LuBoxes;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2'
      }`}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

/**
 * PausedTicket — shown in the right rail when there are no live markets. A
 * blurred, inert ticket skeleton (so the layout doesn't collapse) behind a small
 * card that explains the pause, carries the live BTC Fear & Greed reading, and
 * hands off to Kelly (who still reads BTC when nothing is tradeable). Flips back
 * to the real ticket automatically the moment markets return.
 */
function PausedTicket() {
  return (
    <div data-tour="ticket" className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
        <span className="h-3 w-px bg-accent/70" />
        Trade ticket
      </h2>
      <div className="relative overflow-hidden rounded-xl border border-line">
        <div aria-hidden className="pointer-events-none select-none blur-[3px] saturate-50">
          <TicketSkeleton />
        </div>
        <div className="absolute inset-0 grid place-items-center bg-bg-0/55 p-4">
          <div className="w-full max-w-64 rounded-xl border border-line bg-bg-1/95 p-4 text-center shadow-[0_12px_34px_-14px_rgba(0,0,0,0.85)]">
            <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-white/5 text-text-2">
              <LuPause size={15} />
            </span>
            <p className="mt-3 text-[12.5px] font-medium text-text-1">Markets are paused</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">
              No BTC markets are live right now. New ones open here on their own, then trading turns back on.
            </p>
            <FearGreedRead />
            <Link
              href="/v2/copilot"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[11px] text-text-2 transition-colors hover:border-accent/40 hover:text-text-1"
            >
              <LuSparkles size={12} />
              Ask Kelly about BTC
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The live BTC Fear & Greed reading (Clawby-sourced) shown on the paused ticket.
 *  Renders nothing until it loads, so the card never shows a placeholder number. */
function FearGreedRead() {
  const { data } = useBtcInsights();
  const s = data?.sentiment;
  if (!s) return null;
  const tone = s.value <= 25 ? 'var(--down)' : s.value >= 75 ? 'var(--up)' : 'var(--warn)';
  return (
    <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-line bg-white/2 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider text-text-3">Fear &amp; Greed</span>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
      <span className="font-mono text-[12.5px] tabular-nums text-text-1">{s.value}</span>
      <span className="text-[11px] text-text-2">{s.label}</span>
    </div>
  );
}

/** A static, non-interactive ticket shape sitting (blurred) behind the paused
 *  card — keeps the rail from collapsing without feeding a null market to the
 *  real ticket. Not data, just texture. */
function TicketSkeleton() {
  const rows = ['Level', 'Ends in', 'Amount', 'Leverage', 'Chance it hits', 'Payout if it hits'];
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-line py-2 text-center text-[11px] font-medium text-text-2">UP</div>
        <div className="rounded-lg border border-line py-2 text-center text-[11px] font-medium text-text-2">DOWN</div>
      </div>
      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <div key={r} className="flex items-center justify-between border-b border-line pb-2 text-[11px]">
            <span className="text-text-3">{r}</span>
            <span className="text-text-3">—</span>
          </div>
        ))}
      </div>
      <div className="mt-1 rounded-lg bg-white/5 py-2.5 text-center text-[12px] text-text-3">Place · Mint</div>
    </div>
  );
}

/** Picker area stand-in while markets are paused (the picker would otherwise be
 *  an empty table). */
function PickerPaused() {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <div className="max-w-xs">
        <p className="text-[12.5px] text-text-2">No markets are live right now</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">
          New BTC markets open here automatically once trading resumes. The chart above stays live in the meantime.
        </p>
      </div>
    </div>
  );
}

