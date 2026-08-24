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
import { useMemo, useState, type ReactNode } from 'react';
import { LuChartCandlestick } from 'react-icons/lu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useV2Pricers } from '@/lib/hooks/use-v2-pricers';
import { useBtcInsights, type BtcInsights } from '@/lib/hooks/use-btc-insights';
import { useSkewFeeV2 } from '@/lib/hooks/use-skew-fee-v2';
import { useBtcPositioning, type Positioning } from '@/lib/hooks/use-btc-positioning';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useMarketBook } from '@/lib/hooks/use-market-book';
import { useV2Risk } from '@/lib/hooks/use-v2-risk';
import { useIvHistory } from '@/lib/hooks/use-iv-history';
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
import { OptionsEdgeScanner } from './edge-scanner';
import { OurBook } from './our-book';
import { HouseBook } from './house-book';
import { FlowHistoryPanel } from './flow-history';
import { VolRank } from './vol-rank';
import { SurfaceStatement } from './surface-statement';
import { GreeksScenario } from './greeks-scenario';
import { StrategyBuilder } from './strategy-builder';
import { PlainOnly, ProOnly, Term, VocabProvider, useVocab } from './vocab';
import { buildMarketIntel, buildHouseBook, buildSurfaceHeadline, forwardBasisPct, riskReversal, getAsset, analyzeStrikeForMarket, buildConsensus, defaultExpiryId, expectedMove, expiryLabel, outsideContext, tenorBand, type Consensus, type EngineCandidate, type MarketExpiry, type MarketIntel, type MarketRead, type SurfaceHeadline } from '@/lib/insights';
import { paidProbAt, type MarketBook } from '@/lib/analytics/market-book';
import type { FlowHistory } from '@/lib/analytics/flow-history';
import { timeLeftWords } from '@/lib/format';
import { pythSpot, qkV2 } from '@/lib/api/v2/client';
import { OptionsShareModal } from './options-share-modal';
import { ShareXButton } from '../share/share-x-button';
import type { OptionsShareCard } from '@/lib/share/options-share';
import { ladderSide, type LadderRung } from '@/lib/markets/v2-ladder';
import { feeRatesFor, netPayoutMultiple } from '@/lib/markets/v2-fees';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { rangeFair } from '@/lib/svi/svi';
import { toFloat, fromFloat } from '@/config/scale';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market, PythObservation } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

// One-switch flip to production (no code change). While off, the page renders the
// real surface + ladder blurred behind a "coming soon" card and spends zero Clawby
// credits (insights + candles are gated).
const OPTIONS_LIVE = process.env.NEXT_PUBLIC_OPTIONS_LIVE === '1';

/** The lower-page analytics, grouped into tabs so the page reads as a cockpit
 *  rather than one long feed — and so the heavy tools (and the strategy builder's
 *  wallet hook) only mount when their tab is opened. */
type DeckTab = 'bet' | 'scan' | 'context' | 'build';
/** `pro: true` sections are the desk tools — a cross-expiry screener, a positioning
 *  deck and a multi-leg builder. In Plain the deck collapses to the one section that
 *  answers the question a newcomer actually has ("is this bet any good?"), and the tab
 *  bar disappears with it, because a row of tabs over a single section is furniture. */
const DECK_TABS: { key: DeckTab; label: string; hint: string; pro?: boolean }[] = [
  { key: 'bet', label: 'This bet', hint: 'The odds and payoff for the strike you’ve picked.' },
  { key: 'scan', label: 'Scan', hint: 'Where the surface is cheap versus recent history, across every expiry.', pro: true },
  { key: 'context', label: 'The market', hint: 'Who else is betting, how the money came in, and who is on the other side.' },
  { key: 'build', label: 'Build', hint: 'Combine several legs into one payoff, then place them together.', pro: true },
];


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
  const setRangeBand = useV2TradeStore((s) => s.setRangeBand);
  const storeStrike = useV2TradeStore((s) => s.strikePrice);
  const storeIsUp = useV2TradeStore((s) => s.isUp);

  // Our own fee rate, straight off the on-chain FeeConfig, so every payout and EV on
  // this page is quoted against what the trader is actually charged. 0 when the
  // router is not published for this network.
  const { feeBps: skewFeeBps } = useSkewFeeV2();

  // Clawby-backed reads, gated on the live flag (zero credits behind the gate).
  const { data: insights, loading: insightsLoading } = useBtcInsights({ enabled: OPTIONS_LIVE });
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

  // The page opens on the soonest expiry with enough life left to say something, not
  // simply the next one to settle (see `defaultExpiryId`). Judged against the LIVE feed
  // clock: `serverNow` is fixed at render, so an hour into a session it would still be
  // measuring "3 minutes left" from a stale mark and could re-default onto a market that
  // is seconds from settling. An explicit pick — the expiry pills, the surface, or the
  // Trade screen's shared store — always wins.
  const defaultId = defaultExpiryId(
    markets.map((m) => ({ marketId: m.expiry_market_id, expiryMs: m.expiry })),
    pulseNow,
  );
  const selected =
    markets.find((m) => m.expiry_market_id === marketId) ??
    markets.find((m) => m.expiry_market_id === defaultId) ??
    markets[0] ??
    null;
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
  // The scanner spans expiries, so its picks name their OWN market (which may differ
  // from the page's selected one) — select that market first, then light/pre-fill.
  function highlightAt(marketId: string, strike: number, isUp: boolean) {
    selectMarket(marketId);
    setMode('binary');
    setIsUp(isUp);
    setStrikePrice(strike);
    markPicked();
  }
  function betAt(marketId: string, strike: number, isUp: boolean) {
    highlightAt(marketId, strike, isUp);
    openTicketSheet();
  }

  // OUR OWN standing interest on the selected market. Feeds both the consensus (as
  // the "what traders paid" read) and the Context tab's book panel, so it is read
  // once here rather than per-panel.
  const { book, flow, isLoading: bookLoading } = useMarketBook(selected, pulseNow);

  const ladderPricer = selectedPricer ?? (selected ? pricers[selected.expiry_market_id] : undefined);
  // The expected range belongs to the expiry the page is ON, not the one that happens to
  // settle next. Falls back to the engine's front-expiry read only while the selected
  // pricer is still loading, so the card never blanks.
  const selectedEm = useMemo(
    () => (ladderPricer ? expectedMove({ forward: ladderPricer.forward, svi: ladderPricer.svi }) : null),
    [ladderPricer],
  );

  /**
   * The expected-range band as a REAL, quotable range bet.
   *
   * The card has always drawn "about 2 in 3 chance it lands in here" and offered no
   * way to bet it — the one shape on the page whose picture and whose product were
   * the same thing, with nothing joining them. The band edges are snapped to the
   * market's admission grid first, so the chance quoted on the button is the chance
   * the ticket will price, and the chance comes from `rangeFair` on the live smile
   * rather than the 1σ convention the caption uses (the two are close but not equal,
   * and the button has to be exact).
   *
   * Null when the snapped band collapses or falls outside the quotable band, which is
   * the same gate the ticket applies.
   */
  const rangeBet = useMemo(() => {
    const em = selectedEm ?? intel.expectedMove;
    if (!em || !selected || !ladderPricer) return null;
    const tick = BigInt(selected.admission_tick_size);
    const lower = toFloat(snapStrikeToAdmission(fromFloat(em.lowPrice), tick));
    const higher = toFloat(snapStrikeToAdmission(fromFloat(em.highPrice), tick));
    if (!(lower > 0) || !(lower < higher)) return null;
    const chance = rangeFair(lower, higher, ladderPricer.forward, ladderPricer.svi);
    if (!(chance > 0.005 && chance < 0.995)) return null;
    return { lower, higher, chance, netPayout: netPayoutMultiple(chance, feeRatesFor(selected, skewFeeBps)) };
  }, [selectedEm, intel.expectedMove, selected, ladderPricer, skewFeeBps]);

  // Where this market's vol sits against its own accumulated history. Shared query
  // key with the Context tab's VolRank, so the page pays for it once.
  const { rank: ivRankRead } = useIvHistory(OPTIONS_LIVE);

  /**
   * The page's opening statement, built from the surface alone: the expected move,
   * which side of the smile is dear, how the term structure is shaped, the basis.
   * Deliberately independent of the picked strike AND of Clawby, so the page says
   * something true about the market on first paint.
   */
  const headline = useMemo<SurfaceHeadline | null>(() => {
    const em = selectedEm ?? intel.expectedMove;
    const shape = ladderPricer && selected ? riskReversal(ladderPricer, selected.expiry, pulseNow) : null;
    const here = selected ? intel.expiries.find((e) => e.marketId === selected.expiry_market_id) : undefined;
    const term =
      intel.expiries.length >= 2
        ? { nearIv: intel.expiries[0].iv, farIv: intel.expiries[intel.expiries.length - 1].iv }
        : null;
    return buildSurfaceHeadline({
      asset: intel.asset.short,
      em,
      horizon: selected ? expiryLabel(selected.expiry, pulseNow) : null,
      shape,
      atmIv: here?.iv ?? null,
      ivBand: ivRankRead?.band ?? null,
      term,
      basisPct: ladderPricer ? forwardBasisPct(ladderPricer.forward, intel.spot) : null,
    });
  }, [selectedEm, intel, selected, ladderPricer, pulseNow, ivRankRead]);

  function betRange() {
    if (!selected || !rangeBet) return;
    selectMarket(selected.expiry_market_id);
    setMode('range');
    setRangeBand(rangeBet.lower, rangeBet.higher);
    markPicked();
    openTicketSheet();
  }

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
    return buildConsensus({
      isUp: consensusIsUp,
      surfaceProb: a.implied,
      sigmaMove: a.sigmaMove,
      empiricalProb: a.empirical?.prob ?? null,
      // The fourth read: the price people actually took on this exact strike + side.
      // Null at a strike nobody has traded, and the panel simply shows three.
      paidProb: paidProbAt(book, consensusStrike, consensusIsUp)?.prob ?? null,
    });
  }, [ladderPricer, selected, consensusStrike, consensusIsUp, liveCloses, pulseNow, book]);

  // Share-to-X: the Options page's shareable snapshots, built from the SAME live
  // data the widgets show. Each opens the card dialog (an ad for the page).
  const [shareCard, setShareCard] = useState<OptionsShareCard | null>(null);
  const shareMarketRead = () => {
    if (!intel.read) return;
    setShareCard({
      kind: 'market_read',
      asset: intel.asset.short,
      headline: intel.read.headline,
      lines: intel.read.lines,
      sentiment: liveInsights?.sentiment ?? null,
    });
  };
  const shareExpectedRange = () => {
    const em = selectedEm ?? intel.expectedMove;
    if (!em || !selected) return;
    setShareCard({
      kind: 'expected_range',
      asset: intel.asset.short,
      forward: em.forward,
      spot: intel.spot,
      sigmaPct: em.sigma * 100,
      lowPrice: em.lowPrice,
      highPrice: em.highPrice,
      horizon: timeLeftWords(selected.expiry - pulseNow),
    });
  };
  const shareOdds = (r: LadderRung, isUp: boolean) => {
    if (!selected) return;
    // Quote the side the ladder was actually showing, not always the up side.
    const side = ladderSide(r, isUp, feeRatesFor(selected, skewFeeBps));
    setShareCard({
      kind: 'bold_odds',
      asset: intel.asset.short,
      strike: r.strike,
      chancePct: side.chance * 100,
      payoutX: side.netPayout,
      horizon: timeLeftWords(selected.expiry - pulseNow),
      isUp,
    });
  };

  if (markets.length === 0) {
    return <div className="card mx-4 my-8 px-4 py-8 text-center text-[13px] text-text-3">No live markets right now. Check back in a moment.</div>;
  }

  const page = (
    <VocabProvider>
      {/* `w-full` is load-bearing, not decoration. This page is a column-flex item with
          auto side margins, which makes it fit-content sized — and fit-content's floor is
          MIN-CONTENT. Pro's ladder is `min-w-[860px]` inside a scroll container, so on a
          768px screen the page sized itself to 926px and the whole document scrolled
          sideways. Pinning the width to 100% (still capped by max-w-7xl) puts the scroll
          back where it belongs: inside the table. Matches every other v2 page. */}
      <div className="mx-auto w-full max-w-7xl px-4 pb-16 pt-4">
        <OptionsHeader intel={intel} insights={liveInsights} serverNow={serverNow} />

        {/* The page's opening STATEMENT, off our own surface and needing no strike.
            This replaces a Plain-only paragraph that explained the product: useful to a
            newcomer, but it meant the page said nothing about the market until someone
            clicked. The statement carries both jobs now, and Plain keeps a single line
            of instruction underneath it. */}
        <SurfaceStatement headline={headline} loading={!mounted || !ladderPricer} />

        {/* Hero: the read + expected move alongside the live surface. */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="flex flex-col gap-3">
            <MarketReadCard read={intel.read} loading={mounted && insightsLoading} onShare={shareMarketRead} />
            <ExpectedMoveBand
              em={selectedEm ?? intel.expectedMove}
              spot={intel.spot}
              horizon={selected ? expiryLabel(selected.expiry, pulseNow) : null}
              asset={intel.asset}
              rangeBet={rangeBet}
              onBetRange={betRange}
              onShare={shareExpectedRange}
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="h-[44vh] min-h-80 overflow-hidden rounded-lg border border-line bg-bg-1">
              {canSurface ? (
                <SurfaceMountV2 inputs={surfaceInputs} markets={markets} serverNow={serverNow} />
              ) : (
                <div className="grid h-full place-items-center text-[12px] text-text-3">Building the live surface…</div>
              )}
            </div>
            {/* One line, Plain only: Pro knows what a surface is.
                It used to add "pick a row below and it lights up here". That is TRUE — a
                row click calls `highlight()` and the surface reads the same store fields
                (verified: clicking a rung moves the shared selection) — but the Bet button
                sitting in that same row opens the ticket OVER the surface, so following the
                instruction most obviously showed nothing happening. A caption that invites
                a reader to test it, against a control that hides the result, is worse than
                no caption. Say what the surface IS and let the interaction speak. */}
            <PlainOnly>
              <p className="text-[11.5px] leading-relaxed text-text-3">
                Every price and every expiry at once, priced live.
              </p>
            </PlainOnly>
          </div>
        </div>

        {/* Expiry selector → drives the ladder + reality check. */}
        <div className="mt-4">
          <ExpiryPills expiries={intel.expiries} selectedId={selected?.expiry_market_id ?? null} now={pulseNow} onSelect={(id) => selectMarket(id)} />
        </div>

        {/* The flagship ladder. */}
        <div className="mt-2">
          <ProbabilityLadder
            market={selected}
            pricer={ladderPricer}
            now={pulseNow}
            skewFeeBps={skewFeeBps}
            onHighlight={highlight}
            onBet={bet}
            onShareOdds={shareOdds}
          />
        </div>

        {/* Analytics deck. Lives in its own component so it can read the Plain/Pro
            mode from context (the provider wraps this whole page, so the screen body
            itself cannot). In Plain it is one section with no tab bar; in Pro it is the
            full cockpit. Only the active section mounts, which keeps the heavy tools —
            and the strategy builder's wallet hook — off the page until asked for. */}
        <AnalyticsDeck
          intel={intel}
          selected={selected}
          markets={markets}
          pricers={pricers}
          ladderPricer={ladderPricer}
          closes={liveCloses}
          now={pulseNow}
          skewFeeBps={skewFeeBps}
          book={book}
          flow={flow}
          bookLoading={bookLoading}
          consensus={consensus}
          consensusStrike={consensusStrike}
          consensusIsUp={consensusIsUp}
          positioning={livePositioning}
          insights={liveInsights}
          onBet={bet}
          onBetAt={betAt}
          onHighlightAt={highlightAt}
        />
        {/* Share-to-X card dialog (market read / expected range / bold odds). */}
        <OptionsShareModal card={shareCard} onClose={() => setShareCard(null)} />
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

/**
 * AnalyticsDeck — the lower half of the page: one section in Plain, four in Pro.
 *
 * Sits INSIDE VocabProvider so it can read the mode (the screen body is the provider's
 * parent and cannot). Plain keeps only "This bet" and drops the tab bar with it; Pro
 * opens on Scan, because a desk trader starts by asking where the value is, not by
 * reading a strike they have not picked yet. Switching modes never strands anyone on a
 * section that no longer exists.
 */
function AnalyticsDeck({
  intel,
  selected,
  markets,
  pricers,
  ladderPricer,
  closes,
  now,
  skewFeeBps,
  book,
  flow,
  bookLoading,
  consensus,
  consensusStrike,
  consensusIsUp,
  positioning,
  insights,
  onBet,
  onBetAt,
  onHighlightAt,
}: {
  intel: MarketIntel;
  selected: V2Market | null;
  markets: V2Market[];
  pricers: Record<string, LivePricer>;
  ladderPricer: LivePricer | null | undefined;
  closes: number[] | null | undefined;
  now: number;
  skewFeeBps: number;
  book: MarketBook;
  flow: FlowHistory;
  bookLoading: boolean;
  consensus: Consensus | null;
  consensusStrike: number | null;
  consensusIsUp: boolean;
  positioning: Positioning | null;
  insights: BtcInsights | null;
  onBet: (strike: number, isUp: boolean) => void;
  onBetAt: (marketId: string, strike: number, isUp: boolean) => void;
  onHighlightAt: (marketId: string, strike: number, isUp: boolean) => void;
}) {
  const { pro } = useVocab();
  const tabs = DECK_TABS.filter((t) => pro || !t.pro);
  // The open section is DERIVED, not stored: what the trader picked, if that section
  // exists in this mode, else the mode's own opener. Pro opens on Scan, because a desk
  // starts by asking where the value is, not by reading a strike they have not picked
  // yet. Deriving it means switching to Plain can never strand anyone on a section Plain
  // does not have, and switching back to Pro returns them to where they were.
  const [picked, setPicked] = useState<DeckTab | null>(null);
  const active: DeckTab = picked && tabs.some((t) => t.key === picked) ? picked : pro ? 'scan' : 'bet';

  const pricerPair = ladderPricer ? { forward: ladderPricer.forward, svi: ladderPricer.svi } : null;
  const betPicked = () => consensusStrike != null && onBet(consensusStrike, consensusIsUp);
  // How much the wider (days-to-weeks) options market has to say about the horizon on
  // screen. Reads time-left, so 1d/1w markets promote it on their own. See lib/insights/tenor.
  const outsideRelevance = selected ? outsideContext(tenorBand(selected.expiry, now)) : 'unrelated';

  return (
    <div className="mt-5">
      {tabs.length > 1 && (
        <SectionTabs
          tabs={tabs}
          active={active}
          onChange={setPicked}
        />
      )}

      <div className={tabs.length > 1 ? 'mt-4' : ''}>
        {active === 'bet' && (
          <div className="flex flex-col gap-4">
            {/* Probability consensus — the flagship, for the picked strike. */}
            <ProbabilityConsensus
              consensus={consensus}
              strikePrice={consensusStrike}
              isUp={consensusIsUp}
              expiryMs={selected?.expiry ?? null}
              onBet={betPicked}
            />
            {/* Payoff & decay — how the picked bet behaves if BTC moves or time passes.
                PRO ONLY. Under the plain labels this is delta and theta with a
                scrubbable mark-vs-expiry diagram, which is a desk instrument however
                it is worded: "If BTC +$100 → +2.3 pts, mark +$12" asks a newcomer to
                read a greek. It was also the third place Plain showed the same
                probability (ladder row, consensus bar, "Chance now" tile). Plain keeps
                the consensus verdict; Pro keeps the instrument. */}
            {pro && (
              <GreeksScenario
                pricer={pricerPair}
                strike={consensusStrike}
                isUp={consensusIsUp}
                expiryMs={selected?.expiry ?? null}
                now={now}
                market={selected}
                skewFeeBps={skewFeeBps}
                onBet={betPicked}
              />
            )}
          </div>
        )}

        {active === 'scan' && (
          /* Edge scanner — the cross-expiry value screener. */
          <OptionsEdgeScanner
            markets={markets}
            pricers={pricers}
            closes={closes}
            now={now}
            skewFeeBps={skewFeeBps}
            onHighlight={onHighlightAt}
            onBet={onBetAt}
          />
        )}

        {active === 'context' && (
          <div className="flex flex-col gap-4">
            {/* OUR book, first. This section used to open on Deribit's pin and a day of
                ETF flow — real numbers about a different market on a different clock —
                while the feed that describes THIS expiry went unread. */}
            <section>
              <div className="mb-3 mt-1 flex items-center gap-2.5">
                <h2 className="text-[14px] font-semibold text-text-1">
                  <Term plain="Who else is betting" pro="Our book" />
                </h2>
                <span className="text-[10.5px] uppercase tracking-wide text-text-3">where the money is on this expiry</span>
                <span className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
              </div>
              <OurBook book={book} forward={pricerPair?.forward ?? null} isLoading={bookLoading} onPick={onBet} />
            </section>

            {/* HOW that book was built. A snapshot cannot tell a market that drifted
                to 63% up over an hour from one that flipped there ninety seconds ago,
                and those mean opposite things. Same order feed as OurBook, so this
                costs no extra request. */}
            <section>
              <div className="mb-3 mt-1 flex items-center gap-2.5">
                <h2 className="text-[14px] font-semibold text-text-1">How it built</h2>
                <span className="text-[10.5px] uppercase tracking-wide text-text-3">money in, over time</span>
                <span className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
              </div>
              <FlowHistoryPanel flow={flow} isLoading={bookLoading} />
            </section>

            {/* THE HOUSE'S BOOK. The one read on this page that cannot be had on any
                other options venue: on Deribit the market maker's inventory is private
                and people pay firms to estimate it, while here the counterparty is a
                public vault. Mounts with this tab rather than with the screen, because
                it fans out one open-interest query per market. */}
            <section>
              <div className="mb-3 mt-1 flex items-center gap-2.5">
                <h2 className="text-[14px] font-semibold text-text-1">
                  <Term plain="Who pays you if you win" pro="The house" />
                </h2>
                <span className="text-[10.5px] uppercase tracking-wide text-text-3">who is on the other side</span>
                <span className="h-px flex-1 bg-linear-to-r from-line to-transparent" />
              </div>
              <HouseBookLive markets={markets} marketId={selected?.expiry_market_id ?? null} />
            </section>

            {/* Everything below is desk vocabulary (a Deribit pin, a term structure,
                an IV rank, implied-vs-realized), so it stays Pro even though the tab
                itself is now open to Plain. */}
            <ProOnly>
            {/* The wider options market, weighted by whether it shares our horizon.
                A monthly Deribit pin is a real input to a 1-week bet and says nothing
                about the next five minutes, so below the hour it is hidden rather than
                shown next to our odds as though the two were comparable. */}
            {outsideRelevance !== 'unrelated' && (
              <PositioningFlow positioning={positioning} insights={insights} intel={intel} relevance={outsideRelevance} />
            )}

            {/* The three vol reads: shape across expiries, today against this market's
                own history, and implied against what actually happened. */}
            <div className="grid gap-3 lg:grid-cols-3">
              <SkewTerm expiries={intel.expiries} arb={intel.arb} now={now} pricers={pricers} spot={intel.spot} />
              <VolRank enabled={OPTIONS_LIVE} />
              <RealityCheck pricer={pricerPair} expiryMs={selected?.expiry ?? null} now={now} closes={closes} />
            </div>
            </ProOnly>
          </div>
        )}

        {active === 'build' && (
          /* Strategy builder — combine legs on this expiry into one payoff + place all. */
          <StrategyBuilder market={selected} pricer={pricerPair} />
        )}
      </div>
    </div>
  );
}

/**
 * The vault read, wired. Deliberately a container rather than a prop on the screen:
 * `useV2Risk` fans out one open-interest query per active market, and the Context tab
 * is the only place that needs it, so mounting the hook here keeps those queries off
 * the page until a trader actually opens the tab. Query keys are shared with the risk
 * route, so a trader who has been there already has the data cached.
 */
function HouseBookLive({ markets, marketId }: { markets: V2Market[]; marketId: string | null }) {
  const { risk, isLoading } = useV2Risk(markets);
  const house = useMemo(() => buildHouseBook(risk, marketId), [risk, marketId]);
  return <HouseBook house={house} isLoading={isLoading} />;
}

function MarketReadCard({ read, loading, onShare }: { read: MarketRead | null; loading?: boolean; onShare?: () => void }) {
  const { pro } = useVocab();
  // While the read is still loading, hold the card's footprint with a skeleton that
  // matches the final layout, so the real lines swap IN PLACE instead of the card
  // popping in short and then resizing as the content lands (the "shrink then
  // extend" jank on first landing). Once loaded-but-empty (no data / gated), it
  // collapses to nothing as before.
  if (!read) return loading ? <MarketReadSkeleton /> : null;
  return (
    // Same min height as the skeleton (below) IN PRO, so the real read swaps in place
    // instead of the card growing and shoving the expected-move card + surface down —
    // the "loads short then snaps taller" jank. Plain has no supporting lines to hold
    // room for, so it sizes to its headline rather than reserving three lines of air.
    <div className={`glass rounded-lg p-4 ${pro ? 'min-h-60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10.5px] uppercase tracking-wider text-text-3">Surface read</div>
        {/* Share is Pro chrome. In Plain it was one of three share buttons stacked
            above the fold, each competing with the single action the page wants. */}
        {onShare && pro && <ShareXButton onClick={onShare} label="Share the market read" />}
      </div>
      <p className="mt-2 text-[13.5px] font-medium leading-snug text-text-1">{read.headline}</p>
      {/* The three supporting sentences are Pro only. In Plain they sat in a stack of
          THREE prose blocks (this, the orientation line, the expected-range caption)
          that a newcomer had to read past before reaching anything clickable. The
          headline already carries the read; the detail is for someone who wants it. */}
      {pro && (
        <ul className="mt-2 space-y-1.5">
          {read.lines.map((l, i) => (
            <li key={i} className={`text-[12.5px] leading-relaxed ${l.tone === 'up' ? 'text-up' : l.tone === 'down' ? 'text-down' : 'text-text-2'}`}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Placeholder for the Surface read that reserves the full read's height (a headline
 *  plus three two-row observations) with the SAME `min-h` floor as the loaded card, so
 *  the real copy swaps in without the card growing and reflowing everything under it. */
function MarketReadSkeleton() {
  return (
    <div className="glass min-h-60 rounded-lg p-4" aria-hidden>
      <div className="text-[10.5px] uppercase tracking-wider text-text-3">Surface read</div>
      {/* headline */}
      <div className="mt-2.5 h-3.5 w-3/5 animate-pulse rounded bg-white/10" />
      {/* three observations, each ~two wrapped rows — mirrors the trend / liquidation /
          sentiment sentences the loaded read fills in, so the shapes line up. */}
      <div className="mt-3.5 space-y-3">
        {([['w-full', 'w-2/3'], ['w-11/12', 'w-1/2'], ['w-full', 'w-3/4']] as const).map(([a, b], i) => (
          <div key={i} className="space-y-1.5">
            <div className={`h-3 ${a} animate-pulse rounded bg-white/5`} />
            <div className={`h-3 ${b} animate-pulse rounded bg-white/5`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The analytics-deck tab bar. A group of segmented buttons (aria-pressed, like the
 *  vocab toggle) plus a one-line hint for the active tab, so switching sections
 *  keeps the page short without hiding what each tab holds. */
function SectionTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: DeckTab; label: string; hint: string }[];
  active: DeckTab;
  onChange: (k: DeckTab) => void;
}) {
  const hint = tabs.find((t) => t.key === active)?.hint ?? '';
  return (
    <div>
      <div role="group" aria-label="Analytics sections" className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={active === t.key}
            onClick={() => onChange(t.key)}
            className={`rounded-md px-3.5 py-1.5 text-[12.5px] font-medium ring-1 ring-inset transition ${
              active === t.key
                ? 'bg-(--accent-soft) text-accent ring-(--accent-line)'
                : 'bg-bg-2 text-text-2 ring-line hover:text-text-1'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] text-text-3">{hint}</p>
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
        // "45 sec", not "0m" — see `expiryLabel`.
        const label = expiryLabel(e.expiryMs, now);
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
