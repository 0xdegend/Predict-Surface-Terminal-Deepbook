'use client';

/**
 * V2OptionsScreen — the BTC Options page. The live 3-D surface, a plain-language
 * probability ladder, the expected-move band, a term-structure read, and a reality
 * check — every number from the shared engine (buildMarketIntel), every ladder rung
 * one click from a bet via the SAME shared trade store the Trade page uses.
 *
 * Perf isolation (same discipline as the co-pilot): the heavy surface must not
 * re-render on per-tick sources. `now`/`spot` are READ imperatively from the live
 * tape in the query cache (never subscribed); the header owns its own 1s clock in a
 * leaf. The screen re-renders only on market selection + the 5s pricer refresh.
 *
 * Feature-flagged like the co-pilot: ships behind a "coming soon" gate (the real
 * surface + ladder blurred underneath). Flip NEXT_PUBLIC_OPTIONS_LIVE=1 to go live.
 */
import { useMemo, type ReactNode } from 'react';
import { LuChartCandlestick } from 'react-icons/lu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useBtcInsights } from '@/lib/hooks/use-btc-insights';
import { useBtcPositioning } from '@/lib/hooks/use-btc-positioning';
import { useMounted } from '@/lib/hooks/use-mounted';
import type { BtcCandles } from '@/lib/hooks/use-strike-analysis';
import { SurfaceMountV2 } from '../surface/surface-mount';
import { V2CopilotTicketModal } from '../copilot/copilot-ticket-modal';
import { OptionsHeader } from './options-header';
import { ExpectedMoveBand } from './expected-move-band';
import { ProbabilityLadder } from './probability-ladder';
import { RealityCheck } from './reality-check';
import { SkewTerm } from './skew-term';
import { PositioningFlow } from './positioning-flow';
import { ProbabilityConsensus } from './consensus';
import { VocabProvider } from './vocab';
import { buildMarketIntel, getAsset, analyzeStrikeForMarket, buildConsensus, type EngineCandidate, type MarketExpiry, type MarketRead } from '@/lib/insights';
import { pythSpot, qkV2 } from '@/lib/api/v2/client';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market, PythObservation } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

// One-switch flip to production (no code change). While off, the page renders the
// real surface + ladder blurred behind a "coming soon" card and spends zero Clawby
// credits (insights + candles are gated).
const OPTIONS_LIVE = process.env.NEXT_PUBLIC_OPTIONS_LIVE === '1';

/** Compact "time left" for the consensus question ("3 min" / "2h" / "1d"). */
function fmtTime(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function V2OptionsScreen({
  markets: initialMarkets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  const markets = useV2Markets(initialMarkets);
  const marketId = useV2TradeStore((s) => s.marketId);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setMode = useV2TradeStore((s) => s.setMode);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);
  const storeStrike = useV2TradeStore((s) => s.strikePrice);
  const storeIsUp = useV2TradeStore((s) => s.isUp);

  // Clawby-backed reads, gated on the live flag (zero credits behind the gate).
  const { data: insights } = useBtcInsights({ enabled: OPTIONS_LIVE });
  const { data: positioning } = useBtcPositioning({ enabled: OPTIONS_LIVE });
  const { data: candles } = useQuery<BtcCandles>({
    queryKey: ['insights', 'btc', 'candles'],
    queryFn: async () => {
      const r = await fetch('/api/insights/btc/candles');
      if (!r.ok) throw new Error(`candles ${r.status}`);
      return (await r.json()) as BtcCandles;
    },
    enabled: OPTIONS_LIVE,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const marketIds = useMemo(() => markets.map((m) => m.expiry_market_id), [markets]);
  const pricers = useV2Pricers(marketIds, pricerSeeds, 5_000);

  const selected = markets.find((m) => m.expiry_market_id === marketId) ?? markets[0] ?? null;
  const { data: selectedPricer } = useV2Pricer(
    selected?.expiry_market_id ?? null,
    selected ? pricerSeeds[selected.expiry_market_id] : undefined,
  );

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
  const canSurface = surfaceInputs.length >= 2;

  // now/spot READ from the live tape in the query cache (never subscribed). Every
  // live source (the tape cache + the Clawby fetches) is client-only, so it's gated
  // on `mounted` — false on the server and the first client render, true after. That
  // makes intel + every panel below identical on SSR and first paint (no hydration
  // mismatch, §10.7), then they switch to live values right after hydration.
  const queryClient = useQueryClient();
  const mounted = useMounted();
  const pythObs = mounted ? queryClient.getQueryData<PythObservation | null>(qkV2.pythLatest) ?? null : null;
  const pulseSpot = pythSpot(pythObs);
  const pulseNow = pythObs?.source_timestamp_ms ?? pythObs?.checkpoint_timestamp_ms ?? serverNow;
  const liveInsights = mounted ? insights ?? null : null;
  const liveCloses = mounted ? candles?.closes ?? null : null;
  const livePositioning = mounted ? positioning ?? null : null;

  const candidates = useMemo<EngineCandidate[]>(
    () =>
      markets.flatMap((m) => {
        const p = pricers[m.expiry_market_id];
        return p ? [{ marketId: m.expiry_market_id, expiryMs: m.expiry, pricer: { forward: p.forward, svi: p.svi } }] : [];
      }),
    [markets, pricers],
  );

  const intel = useMemo(
    () =>
      buildMarketIntel({
        asset: getAsset('BTC'),
        now: pulseNow,
        spot: pulseSpot,
        ctx: liveInsights,
        candidates,
        closes: liveCloses,
        surfaceInputs,
      }),
    [pulseNow, pulseSpot, liveInsights, candidates, liveCloses, surfaceInputs],
  );

  // Light a strike on the surface + pre-fill the ticket selection (shared store).
  function highlight(strike: number, isUp: boolean) {
    if (!selected) return;
    selectMarket(selected.expiry_market_id);
    setMode('binary');
    setIsUp(isUp);
    setStrikePrice(strike);
    markPicked();
  }
  function bet(strike: number, isUp: boolean) {
    highlight(strike, isUp);
    openTicketSheet();
  }

  const ladderPricer = selectedPricer ?? (selected ? pricers[selected.expiry_market_id] : undefined);

  // The consensus tracks the picked strike (default: the ATM up bet on the front market).
  const consensusStrike = storeStrike ?? ladderPricer?.forward ?? null;
  const consensusIsUp = storeStrike != null ? storeIsUp : true;
  const consensus = useMemo(() => {
    if (!ladderPricer || !selected || consensusStrike == null) return null;
    const a = analyzeStrikeForMarket({
      closes: liveCloses,
      pricer: ladderPricer,
      strike: consensusStrike,
      isUp: consensusIsUp,
      expiryMs: selected.expiry,
      now: pulseNow,
    });
    if (!a) return null;
    return buildConsensus({ isUp: consensusIsUp, surfaceProb: a.implied, sigmaMove: a.sigmaMove, empiricalProb: a.empirical?.prob ?? null });
  }, [ladderPricer, selected, consensusStrike, consensusIsUp, liveCloses, pulseNow]);

  if (markets.length === 0) {
    return <div className="card mx-4 my-8 px-4 py-8 text-center text-[13px] text-text-3">No live markets right now — check back in a moment.</div>;
  }

  const page = (
    <VocabProvider>
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-4">
        <OptionsHeader intel={intel} insights={liveInsights} serverNow={serverNow} />

        {/* Hero: the read + expected move alongside the live surface. */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="flex flex-col gap-3">
            <MarketReadCard read={intel.read} />
            <ExpectedMoveBand em={intel.expectedMove} spot={intel.spot} asset={intel.asset} />
          </div>
          <div className="h-[44vh] min-h-80 overflow-hidden rounded-lg border border-line bg-bg-1">
            {canSurface ? (
              <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} />
            ) : (
              <div className="grid h-full place-items-center text-[12px] text-text-3">Building the live surface…</div>
            )}
          </div>
        </div>

        {/* Expiry selector → drives the ladder + reality check. */}
        <div className="mt-4">
          <ExpiryPills expiries={intel.expiries} selectedId={selected?.expiry_market_id ?? null} now={pulseNow} onSelect={(id) => selectMarket(id)} />
        </div>

        {/* The flagship ladder. */}
        <div className="mt-2">
          <ProbabilityLadder market={selected} pricer={ladderPricer} closes={liveCloses} now={pulseNow} onHighlight={highlight} onBet={bet} />
        </div>

        {/* Probability consensus — the flagship, for the picked strike. */}
        <div className="mt-4">
          <ProbabilityConsensus
            consensus={consensus}
            strikePrice={consensusStrike}
            isUp={consensusIsUp}
            timeLabel={selected ? fmtTime(selected.expiry - pulseNow) : ''}
            onBet={() => consensusStrike != null && bet(consensusStrike, consensusIsUp)}
          />
        </div>

        {/* Positioning & flow — the "why behind the odds" (Clawby PRO). */}
        <div className="mt-4">
          <PositioningFlow positioning={livePositioning} insights={liveInsights} intel={intel} />
        </div>

        {/* Term structure + reality check. */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <SkewTerm expiries={intel.expiries} arb={intel.arb} now={pulseNow} />
          <RealityCheck
            pricer={ladderPricer ? { forward: ladderPricer.forward, svi: ladderPricer.svi } : null}
            expiryMs={selected?.expiry ?? null}
            now={pulseNow}
            closes={liveCloses}
          />
        </div>
      </div>
    </VocabProvider>
  );

  if (!OPTIONS_LIVE) return <OptionsComingSoon>{page}</OptionsComingSoon>;

  return (
    <>
      {page}
      <V2CopilotTicketModal market={selected} pricer={selectedPricer} serverNow={serverNow} />
    </>
  );
}

function MarketReadCard({ read }: { read: MarketRead | null }) {
  if (!read) return null;
  return (
    <div className="glass rounded-lg p-4">
      <div className="text-[10.5px] uppercase tracking-wider text-text-3">Surface read</div>
      <p className="mt-2 text-[13.5px] font-medium leading-snug text-text-1">{read.headline}</p>
      <ul className="mt-2 space-y-1.5">
        {read.lines.map((l, i) => (
          <li key={i} className={`text-[12.5px] leading-relaxed ${l.tone === 'up' ? 'text-up' : l.tone === 'down' ? 'text-down' : 'text-text-2'}`}>
            {l.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExpiryPills({
  expiries,
  selectedId,
  now,
  onSelect,
}: {
  expiries: MarketExpiry[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
}) {
  if (expiries.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] uppercase tracking-wide text-text-3">Expiry</span>
      {expiries.slice(0, 8).map((e) => {
        const active = e.marketId === selectedId;
        const m = Math.max(0, Math.round((e.expiryMs - now) / 60_000));
        const label = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
        return (
          <button
            key={e.marketId}
            type="button"
            onClick={() => onSelect(e.marketId)}
            className={`rounded-md px-2.5 py-1 font-mono text-[12px] tabular-nums ring-1 ring-inset transition ${
              active ? 'bg-(--accent-soft) text-accent ring-(--accent-line)' : 'bg-bg-2 text-text-2 ring-line hover:text-text-1'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The launch gate — the real page blurred and inert behind a centred glass card,
 * so it teases the finished thing. Flip NEXT_PUBLIC_OPTIONS_LIVE=1 to remove it.
 */
function OptionsComingSoon({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div inert aria-hidden className="pointer-events-none select-none blur-[6px]">
        {children}
      </div>
      <div className="absolute inset-0 bg-bg-0/55" />
      <div className="absolute inset-0 grid place-items-center px-6">
        <div className="glass-card relative w-full max-w-md overflow-hidden p-9 text-center">
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-40 w-40 -translate-x-1/2 -translate-y-16 rounded-full bg-(--accent-glow) blur-3xl" />
          <div className="relative">
            <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-full bg-(--accent-soft) text-accent ring-1 ring-(--accent-line)">
              <LuChartCandlestick size={22} className="relative" />
            </span>
            <h1 className="mt-6 text-[22px] font-semibold tracking-tight text-text-1">BTC Options</h1>
            <p className="mx-auto mt-3 max-w-sm text-[13.5px] leading-relaxed text-text-2">
              The clearest read on Bitcoin options — the live surface, a plain-language probability ladder, expected
              move, and a reality check. Every number is one click from a bet.
            </p>
            <p className="mt-5 text-[12px] text-text-3">We’re putting the finishing touches on it.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
