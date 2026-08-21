'use client';

/**
 * SimpleScreen — the calm UP/DOWN "round" trade view (`/v2/simple`).
 *
 * One live round in the hero (the soonest tradeable market of the chosen cadence),
 * shown as a live price chart with the round's pinned LINE and a countdown, plus a
 * compact ticket. The trader enters exactly two things: how much, and which way.
 * Everything else (the market, the strike/line, 1x leverage) is picked for them.
 *
 * Below it, the OTHER rounds open right now are laid out as cards that can be bet
 * directly — same amount, same confirm step, same mint. Every one of them prices
 * through `useRoundQuote` and draws off the one shared price series, so a card and the
 * hero ticket can never disagree, and a screen full of charts costs no extra network.
 *
 * It reuses the SAME markets / pricer / mint plumbing as the full ticket, so its trades
 * land on the leaderboard, portfolio and PnL like any other — it's a front-end, not a
 * second engine. See [[simple-mode]].
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSkewFeeV2 } from '@/lib/hooks/use-skew-fee-v2';
import { skewFeeBase } from '@/lib/sui/v2/skew-fee';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { usePythTapeFeed } from '@/lib/hooks/use-v2-pyth-history';
import { useSpotSeries } from '@/lib/hooks/use-spot-series';
import { useRoundQuote } from '@/lib/hooks/use-round-quote';
import { useNow } from '@/lib/hooks/use-now';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useMounted } from '@/lib/hooks/use-mounted';
import { getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { RollingNumber } from '@/app/_components/ui/rolling-number';
import { momentumOf, type Momentum } from '@/lib/charts/simple-series';
import { isTooCloseToExpiry, CADENCE_ORDER, type V2Cadence } from '@/lib/markets/v2-discovery';
import { pickAllRounds, otherBandRounds, type HeldPicks } from '@/lib/markets/round-pick';
import { type SideQuote } from '@/lib/sui/v2/simple-round';
import { leverageScaled } from '@/lib/sui/v2/ticks';
import { fromQuote } from '@/config/scale';
import { price } from '@/lib/format';
import { STARTER_DEFAULT_STAKE, defaultStakeForBalance, betPresets } from '@/lib/store/v2-trade-store';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { SimpleRoundChart } from './simple-chart';
import { RoundCards, type HorizonRound, type RoundPick } from './round-cards';
import { MyBets } from './my-bets';
import { ResultsTape } from './results-tape';
import { SimpleSkeleton } from './simple-skeleton';
import { SideButton } from './side-button';
import { CADENCE_META, CADENCE_TABS, clock } from './cadence';
import { sanitizeAmount } from './amount';
import { SimpleBetDrawer, type BetIntent } from './bet-drawer';
import { GlassError } from '../../ui/glass-error';
import { MintConfirmModal, type ConfirmRow } from '@/app/_components/mint-confirm-modal';
import { MintSuccessModal } from '@/app/_components/mint-success-modal';
import { SessionOptInRow } from '../session/session-opt-in-row';
import { predictV2Config, ACTIVE_NETWORK } from '@/config/predict';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const SYM = predictV2Config.quote.symbol;
const usd = (base: bigint) => `$${fromQuote(base).toFixed(2)} ${SYM}`;

/** Trailing window the hero chart draws, and the lookback the momentum tint reads. */
const CHART_WINDOW_S = 120;
const MOMENTUM_LOOKBACK_S = 30;
/** How many other rounds to card up. Each one costs a pricer simulate every ~5s, so this
 *  is a load budget as much as a layout choice. Four fills a 2x2 on a phone and one row on
 *  a wide screen, and the live ladder rarely holds more than five besides the hero. */
const MAX_OTHER_ROUNDS = 4;

type SuccessState = { headline: string; tone: 'up' | 'down'; rows: ConfirmRow[]; staked: string; maxWin: string; digest: string };

export function SimpleScreen({
  markets: initialMarkets,
  pricerSeeds,
  stateSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  stateSeeds: Record<string, V2MarketState>;
  serverNow: number;
}) {
  const acct = usePredictAccountV2();
  const skewFee = useSkewFeeV2();
  // Keep the rolling pyth-tape buffer fed (and the live spot read on the checkpoint
  // stream) for as long as this screen is mounted. The history walk is a one-shot, so
  // the tape is what keeps the charts' right-hand side current.
  usePythTapeFeed();
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);

  const markets = useV2Markets(initialMarkets);
  const now = useNow(serverNow);
  // Only a BEHAVIOUR switch (bet straight away vs ask for the amount first); the layout
  // itself is CSS, so this never gates what renders.
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [cadence, setCadence] = useState<V2Cadence>('1m');
  // The amount lives as text so the box shows exactly what was typed (see sanitizeAmount);
  // everything downstream reads the derived number.
  const [stakeText, setStakeText] = useState(String(STARTER_DEFAULT_STAKE));
  const stake = Number(stakeText) || 0;
  const [confirm, setConfirm] = useState<RoundPick | null>(null);
  // Mobile bet drawer. `betIntent` stays populated while the sheet slides OUT, so its
  // content doesn't vanish mid-animation; `betOpen` is what actually drives the slide.
  const [betIntent, setBetIntent] = useState<BetIntent | null>(null);
  const [betOpen, setBetOpen] = useState(false);
  const [success, setSuccess] = useState<SuccessState | null>(null);

  // The ONE price series every chart on this screen draws from (hero + every card).
  const { points: series, ready: seriesReady } = useSpotSeries(CHART_WINDOW_S);
  const momentum = useMemo(() => momentumOf(series, MOMENTUM_LOOKBACK_S), [series]);

  // The live tick for the price card: the very same shared pyth-latest entry the nav
  // spot tape polls at 250ms, so the card moves exactly as often as the nav does — and
  // lands on the same number the chart's live dot is drawn at. Deliberately NO interval
  // of its own; the nav tape drives this key from the always-mounted chrome, so this is
  // a pure observer. The pricer can't drive the readout: it re-simulates at best once
  // every 2.5s, which is what made the card feel frozen next to the nav.
  const spotQ = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(predictV2Config.asset.pythFeedId),
  });
  const liveSpot = pythSpot(spotQ.data ?? null);
  // See the note on `spot` in price-chart.tsx: the server has no live pyth read, so any
  // value from this shared query during the hydration pass disagrees with the HTML.
  const mounted = useMounted();

  /**
   * One round per tab, chosen by TIME REMAINING rather than by which series created the
   * market — see [[lib/markets/round-pick]] for the measurements that forced this. The
   * picks are held in state so a countdown can never jump backwards when a further-out
   * round crosses into a band; adjusted during render (React's "you might not need an
   * effect"), and the equality check is what stops it looping on the 1s clock.
   */
  const [heldPicks, setHeldPicks] = useState<HeldPicks>({});
  const picks = useMemo(() => pickAllRounds(markets, now, heldPicks), [markets, now, heldPicks]);
  const pickIds: HeldPicks = {
    '1m': picks['1m']?.expiry_market_id,
    '5m': picks['5m']?.expiry_market_id,
    '1h': picks['1h']?.expiry_market_id,
  };
  if (CADENCE_ORDER.some((c) => pickIds[c] !== heldPicks[c])) setHeldPicks(pickIds);

  const active = picks[cadence];
  // In its last few seconds a mint can no longer land, so the round is shown (the
  // countdown is real) but not bettable — rather than jumping to a round of the wrong
  // length just to keep the buttons alive.
  const closing = !!active && isTooCloseToExpiry(active, now);

  const hero = useRoundQuote(active, stake, {
    pricer: active ? pricerSeeds[active.expiry_market_id] : undefined,
    state: active ? stateSeeds[active.expiry_market_id] : undefined,
  });
  const { line, lineInfo, upQ, dnQ } = hero;
  // Said out loud whenever the round has left its opening line behind, so the headline
  // number changing reads as a deliberate move rather than a glitch. See
  // `chooseRoundLine` for why a line moves at all.
  const movedNote = lineInfo?.moved
    ? 'Bitcoin ran past the opening strike, so this round now runs from the current price.'
    : null;

  // Every OTHER round that is open right now, carded up soonest-first — not just one per
  // tab, which was hiding four of the six or seven live markets. Each still comes out of
  // its horizon band, so a card can never advertise more time than its label
  // ([[lib/markets/round-pick]]).
  const otherRounds = useMemo<HorizonRound[]>(
    () => otherBandRounds(markets, now, active?.expiry_market_id, MAX_OTHER_ROUNDS),
    [markets, now, active],
  );

  // One-time balance-aware default stake — adjusted DURING render (React's "you might
  // not need an effect"), so it never trips set-state-in-effect. Fires once the balance
  // loads, and only while the trader hasn't picked an amount yet.
  const [autoSized, setAutoSized] = useState(false);
  if (!autoSized && acct.walletDusdcBase !== undefined) {
    setAutoSized(true);
    if (stake === STARTER_DEFAULT_STAKE) {
      const s = defaultStakeForBalance(acct.balanceBase + acct.walletDusdcBase);
      if (s !== stake) setStakeText(String(s));
    }
  }

  const spendable = acct.balanceBase + (acct.walletDusdcBase ?? 0n);
  const presets = useMemo(() => betPresets(spendable), [spendable]);

  /** Fee-aware funding for a side — the Skew fee rides the owner path only, so a
   *  session-routed trade is fee-free (mirrors the ticket). */
  function funding(q: SideQuote) {
    const feeAmt = skewFee.enabled ? skewFeeBase(q.stakeBase, skewFee.feeBps) : 0n;
    const baseShort = q.maxCost > acct.balanceBase ? q.maxCost - acct.balanceBase : 0n;
    const willRouteSession = acct.sessionCanTrade && baseShort === 0n;
    const chargesSkewFee = feeAmt > 0n && !willRouteSession;
    const skewFeeDue = chargesSkewFee ? feeAmt : 0n;
    const required = q.maxCost + skewFeeDue;
    const shortfall = required > acct.balanceBase ? required - acct.balanceBase : 0n;
    return { shortfall, skewFeeDue, chargesSkewFee };
  }

  /** Open the mobile amount drawer for a call. */
  function openBet(intent: BetIntent) {
    setBetIntent(intent);
    setBetOpen(true);
  }

  /**
   * A side button was tapped. On a phone the amount isn't on screen (the ticket is
   * desktop-only), so the drawer asks for it first; on desktop the ticket already has
   * it, so the bet goes straight to the confirm/mint funnel.
   */
  function pickSide(pick: RoundPick) {
    if (isDesktop) requestPlace(pick);
    else openBet({ market: pick.market, cadence: pick.cadence, isUp: pick.isUp, lineScaled: pick.lineScaled });
  }

  /** Every bet on this screen — hero ticket, round card or drawer — funnels through here. */
  function requestPlace(pick: RoundPick) {
    if (acct.busy) return;
    if (!acct.owner) return; // buttons show a connect hint instead
    if (!acct.wrapperExists) {
      void acct.createAccount();
      return;
    }
    if (!pick.quote.quotable) return;
    const f = funding(pick.quote);
    // One-tap only when a session is live AND the trade is fully account-funded (a
    // wallet top-up would still pop up).
    if (acct.sessionCanTrade && instantTrade && f.shortfall === 0n) {
      void doMint(pick);
      return;
    }
    setConfirm(pick);
  }

  async function doMint(pick: RoundPick) {
    const { market, quote: q, isUp } = pick;
    const f = funding(q);
    const wasArming = armInstant && !acct.sessionActive;
    const digest = await acct.mintBudget(
      {
        marketId: market.expiry_market_id,
        lowerTick: q.ticks.lowerTick,
        higherTick: q.ticks.higherTick,
        amount: q.amount,
        minQuantity: q.minQuantity,
        leverage: leverageScaled(1),
        deposit: f.shortfall > 0n ? f.shortfall : undefined,
        skewFee: f.chargesSkewFee ? { stake: q.stakeBase, feeBps: skewFee.feeBps, isRange: false } : undefined,
      },
      { silentSuccess: true, startSession: wasArming ? { duration: sessionDuration } : undefined },
    );
    setConfirm(null);
    if (digest) {
      if (wasArming) setArmInstant(false);
      setSuccess({
        headline: `BTC · ${isUp ? 'UP' : 'DOWN'}`,
        tone: isUp ? 'up' : 'down',
        rows: reviewRows(pick, f.chargesSkewFee ? { due: f.skewFeeDue, bps: skewFee.feeBps } : undefined),
        staked: usd(q.stakeBase),
        maxWin: usd(q.winBase),
        digest,
      });
    }
  }

  const secsLeft = active ? Math.max(0, Math.round((active.expiry - now) / 1000)) : 0;
  const px = (mounted ? liveSpot : null) ?? hero.pricer?.forward ?? null;

  /**
   * ROLLOVER, not reload. A round ending used to drop the whole screen — chart, ticket,
   * cards, tape — back to a centred "starting the next round" box for the beat it took
   * the next market's pricer and state to land, then rebuild all of it. Every second's
   * work was thrown away and the page visibly flashed once a minute.
   *
   * Now the layout stays mounted and only the hero's own values go quiet. Two pieces
   * make that read as a smooth handover rather than a stall:
   *
   *   - the LINE is held. It comes back a beat later, and (by construction) a round's
   *     line is the previous round's close, so holding it is both steady and close to
   *     right. Display only — a bet can't be built from it, because the buttons are
   *     gated on live quotes, which are exactly what is missing during the gap.
   *   - the CHART never unmounts. Its series is the shared tape, which has nothing to
   *     do with which round is on screen, so the price line simply keeps drawing.
   */
  const [heldLine, setHeldLine] = useState<number | null>(null);
  if (line != null && line !== heldLine) setHeldLine(line);
  const shownLine = line ?? heldLine;
  const rolling = !active || !hero.ready || line == null;

  /**
   * A cadence with NOTHING live, which is a different thing from a rollover and needs
   * to say so. The hourly series is intermittent — a census against the live chain found
   * it at zero live markets — and `active` is then null forever, so the hero sat on
   * "setting up the next round" indefinitely with no next round coming. The other two
   * cadences keep two markets alive at once, so they never reach this.
   */
  const cadenceEmpty = !active && markets.length > 0;
  const emptyNote = `No ${CADENCE_META[cadence].short} rounds are open right now. Try another round length.`;

  const above = px != null && shownLine != null ? px >= shownLine : true;
  const delta = px != null && shownLine != null ? px - shownLine : null;

  /**
   * First paint only. Once the screen has been live it never returns here — a rollover
   * is handled in place (above), and falling back to a skeleton every minute is the
   * exact flash this latch exists to prevent.
   *
   * Gated on the ROUND, not on the chart. The server hands over seeded pricer and market
   * state, so the round is usually ready on the very first render and the layout paints
   * at once; the chart's ~4-5s backfill then fills in behind its own skeleton, inside a
   * card that is already the right size. Holding the entire page for the chart would
   * trade an instant paint for a blank screen.
   */
  const [everLive, setEverLive] = useState(false);
  // `cadenceEmpty` releases the latch too: landing on a cadence with nothing live is a
  // known answer, not a pending one, and holding the skeleton for it would be a blank
  // screen waiting on a round that isn't coming.
  if (!everLive && (!rolling || cadenceEmpty)) setEverLive(true);

  if (!everLive) {
    if (markets.length === 0) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-3 py-4 sm:px-5">
          <p className="rounded-2xl border border-(--line-soft) bg-bg-1 py-24 text-center text-[13px] text-text-3">
            No live rounds right now — check back in a moment.
          </p>
        </main>
      );
    }
    return <SimpleSkeleton />;
  }

  const cf = confirm ? funding(confirm.quote) : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3 py-4 sm:px-5">
      {/* No Simple/Advanced switch here — desktop has it in the header, mobile in the
          dock's More sheet. Kept off BOTH trade screens deliberately: leaving it on this
          one would mean switching happens in a different place depending on which screen
          you're standing on, and you could never get back the way you came. */}

      {/* title + cadence */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* One line on a phone. The COPY is what buys that, not a smaller type ramp:
            "Bitcoin" → "BTC", and "this round?" → "?" (the cadence tabs right below and
            the chart card's "round closes in" already say which round this is). Measured
            at 15px, the full sentence wants ~425px against the 366px a 390px phone gives,
            so there was no tightening that fitted it. What can't go is the ASSET NAME —
            without it the screen asks "higher or lower than 72,333.12?" about nothing in
            particular, and the nav's BTC chip is small and far away.

            The price keeps its phrase: pill and tail are ONE flex item, so a narrow
            screen or a six-figure price wraps them together instead of stranding the
            number at the end of a line. Flex-wrap stays as that safety net. */}
        <h1 className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[14px] font-semibold tracking-tight text-text-1 sm:text-[17px]">
          <span className="whitespace-nowrap sm:hidden">Will BTC be higher or lower than</span>
          <span className="hidden whitespace-nowrap sm:inline">Will Bitcoin be higher or lower than</span>
          {shownLine != null && (
            <span className="inline-flex items-center">
              <LinePill value={shownLine} momentum={momentum} />
              <span className="sm:hidden">?</span>
              <span className="ml-2 hidden sm:inline">this round?</span>
            </span>
          )}
        </h1>
        {/* Full-width on a phone so each round length is a proper tap target. */}
        <div className="flex w-full shrink-0 gap-1 rounded-xl border border-(--line-soft) bg-bg-1 p-1 sm:w-auto">
          {CADENCE_TABS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCadence(c.id)}
              className={`flex-1 rounded-lg px-3 py-2 font-mono text-[12px] font-semibold transition-colors sm:flex-none sm:py-1.5 ${
                cadence === c.id ? 'bg-bg-3 text-text-1' : 'text-text-3 hover:text-text-2'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Everything below stays mounted through a rollover — see `rolling` above. */}
      <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            {/* ── the chart card ───────────────────────────────────────────────── */}
            <section className="panel flex min-h-0 flex-col overflow-hidden">
              <div className="flex items-start justify-between gap-4 px-4 pb-3 pt-4">
                <div>
                  <div className="eyebrow">Last price</div>
                  {/* Odometer digits, same as the nav tape: the value shown is always the
                      real current tick (no tween) — only each digit's slide animates, so a
                      tick landing mid-slide just retargets the strips. */}
                  <div
                    className="font-mono text-[30px] font-semibold leading-none tabular-nums text-text-1 sm:text-[36px]"
                    aria-label={`Last price ${price(px ?? 0)}`}
                  >
                    <RollingNumber text={price(px ?? 0)} />
                  </div>
                  {delta != null && (
                    <div
                      className={`mt-2 flex items-center gap-1 text-[12.5px] font-semibold tabular-nums ${above ? 'text-up' : 'text-down'}`}
                      aria-label={`${price(Math.abs(delta))} ${above ? 'above' : 'below'} the strike`}
                    >
                      <span aria-hidden="true">{above ? '▲' : '▼'}</span>
                      <RollingNumber text={price(Math.abs(delta))} />
                      <span aria-hidden="true">{above ? 'above' : 'below'} the strike</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="eyebrow">Round closes in</div>
                  {/* Between rounds the clock is the one thing that CAN'T be held — a
                      frozen 0:00 reads as broken — so it dims to a placeholder instead. */}
                  <div
                    className={`font-mono text-[26px] font-semibold leading-none tabular-nums transition-colors duration-300 sm:text-[32px] ${
                      rolling ? 'text-text-3' : 'text-text-1'
                    }`}
                  >
                    {rolling ? '—:—' : clock(secsLeft)}
                  </div>
                  <span className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-text-3">
                    <i
                      className={`h-1.5 w-1.5 rounded-full ${rolling ? 'bg-text-3' : 'bg-up'}`}
                      style={{ animation: 'breathe 2.4s ease-in-out infinite' }}
                    />
                    {rolling ? 'next round' : 'live'}
                  </span>
                </div>
              </div>

              {/* Fills the rest of the panel so there's no dead space below it. NOT keyed
                  on the round: the series is the shared tape and has nothing to do with
                  which market is on screen, so a rollover leaves the price line alone. */}
              <div className="min-h-0 flex-1 px-3 pb-3">
                <SimpleRoundChart series={series} line={shownLine} above={above} ready={seriesReady} />
              </div>

              {/* MOBILE: the call lives on the chart. Scrolling away from the price to
                  reach a ticket is the wrong way round on a phone — tapping here opens
                  the amount drawer instead. Desktop keeps the ticket in the rail. */}
              <div className="grid grid-cols-2 gap-2 px-3 pb-3 lg:hidden">
                <SideButton
                  isUp
                  disabled={!active || rolling || !acct.owner || !!acct.busy || closing || !upQ?.quotable}
                  unpriceable={!!upQ && !upQ.quotable}
                  onPick={() => active && lineInfo && openBet({ market: active, cadence, isUp: true, lineScaled: lineInfo.lineScaled })}
                />
                <SideButton
                  isUp={false}
                  disabled={!active || rolling || !acct.owner || !!acct.busy || closing || !dnQ?.quotable}
                  unpriceable={!!dnQ && !dnQ.quotable}
                  onPick={() => active && lineInfo && openBet({ market: active, cadence, isUp: false, lineScaled: lineInfo.lineScaled })}
                />
              </div>
              {(closing || rolling || movedNote) && (
                <p className="px-3 pb-3 text-center text-[11.5px] text-text-3 lg:hidden">
                  {cadenceEmpty
                    ? emptyNote
                    : rolling
                      ? 'Setting up the next round…'
                      : closing
                        ? 'This round is closing. The next one opens in a moment.'
                        : movedNote}
                </p>
              )}
            </section>

            {/* ── the ticket (desktop) — on mobile the chart's buttons + the bet
                   drawer do this job, and two ways to bet on one screen is noise ── */}
            <aside className="panel hidden flex-col gap-4 p-4 lg:flex">
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">The strike · this round</span>
                <span
                  className={`font-mono text-[22px] font-semibold leading-none tabular-nums transition-colors duration-300 ${
                    rolling ? 'text-text-3' : 'text-text-1'
                  }`}
                >
                  {shownLine == null ? '—' : price(shownLine)}
                </span>
                <span className="text-[11px] leading-snug text-text-3">
                  {cadenceEmpty
                    ? emptyNote
                    : rolling
                      ? 'Setting up the next round…'
                      : hero.lineInfo?.pinned
                        ? 'Fixed for this round. Settles above or below it.'
                        : hero.lineInfo?.moved
                          ? 'Bitcoin ran past the opening strike, so this round now runs from the current price.'
                          : 'The price right now. Higher or lower from here.'}
                </span>
              </div>

              <hr className="border-(--line-soft)" />

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Bet amount</span>
                  <span className="text-[11px] text-text-3">
                    Wallet balance <span className="font-mono tabular-nums">${price(fromQuote(spendable))}</span>
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {presets.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setStakeText(String(p))}
                      className={`flex-1 rounded-lg border py-2 font-mono text-[12.5px] font-semibold transition-colors ${
                        stake === p
                          ? 'border-(--accent-line) bg-(--accent-soft) text-text-1'
                          : 'border-(--line-soft) bg-bg-2 text-text-2 hover:text-text-1'
                      }`}
                    >
                      ${p}
                    </button>
                  ))}
                </div>
                {/* `text` + decimal inputMode, not `number`: it drops the native spinners
                    outright (no per-engine CSS) and lets the value be normalised as typed,
                    while phones still get the numeric keypad. */}
                <input
                  type="text"
                  inputMode="decimal"
                  value={stakeText}
                  onChange={(e) => setStakeText(sanitizeAmount(e.target.value))}
                  placeholder="0"
                  aria-label="Custom amount"
                  className="w-full rounded-lg border border-(--line-soft) bg-bg-2 px-3 py-2 text-center font-mono text-[14px] text-text-1 outline-none focus:border-(--line-strong)"
                />
              </div>

              {/* The stake, restated as RISK — the one thing the ticket never said out
                  loud. Everything else on it is upside: two payout figures and two green
                  and coral buttons, so the amount at stake was never named as a loss.
                  The "You risk" label and the figure carry that; the line below says what
                  winning takes. It also happens to be the right size for the space a
                  taller chart card opens up here, which beats padding the gap. */}
              <div className="mt-auto flex flex-col gap-1.5 rounded-lg border border-(--line-soft) bg-bg-2/40 px-3 py-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">You risk</span>
                  <span className="font-mono text-[15px] font-semibold tabular-nums text-text-1">
                    ${price(stake)}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-text-3">
                  If Bitcoin ends this round on your side of the strike you win.
                </p>
              </div>

              {/* What each call pays at this amount. It sits here rather than on the
                  buttons so the buttons stay one steady target — these figures move on
                  every tick, and a control that reflows under the cursor gets misclicked. */}
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-(--line-soft) bg-bg-2/40 px-2 py-2">
                <PayoutCell isUp q={upQ} />
                <PayoutCell isUp={false} q={dnQ} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <SideButton
                  isUp
                  disabled={!active || rolling || !acct.owner || !!acct.busy || closing || !upQ?.quotable}
                  unpriceable={!!upQ && !upQ.quotable}
                  onPick={() =>
                    active && line != null && lineInfo && upQ &&
                    requestPlace({ market: active, cadence, line, lineScaled: lineInfo.lineScaled, quote: upQ, isUp: true })
                  }
                />
                <SideButton
                  isUp={false}
                  disabled={!active || rolling || !acct.owner || !!acct.busy || closing || !dnQ?.quotable}
                  unpriceable={!!dnQ && !dnQ.quotable}
                  onPick={() =>
                    active && line != null && lineInfo && dnQ &&
                    requestPlace({ market: active, cadence, line, lineScaled: lineInfo.lineScaled, quote: dnQ, isUp: false })
                  }
                />
              </div>

              {(closing || rolling) && (
                <p className="text-center text-[11.5px] text-text-3">
                  {cadenceEmpty ? emptyNote : rolling ? 'Setting up the next round…' : 'This round is closing. The next one opens in a moment.'}
                </p>
              )}

              {!acct.owner ? (
                <p className="text-center text-[11.5px] text-text-3">Connect your wallet (top right) to place a bet.</p>
              ) : !acct.wrapperExists ? (
                <p className="text-center text-[11.5px] text-text-3">
                  {acct.busy === 'create'
                    ? 'Setting up your free trading account…'
                    : 'Your first tap sets up a free trading account, then tap again to bet.'}
                </p>
              ) : null}

              {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
            </aside>
          </div>

          {/* The loop, closed: what you have running right now, then what else is open,
              then how the last rounds went. Self-gating — "Your bets" renders nothing
              until there is a bet, so a first-timer still gets the quiet screen they
              came for, and the results tape carries the page's baseline content. */}
          <MyBets now={now} />

          <RoundCards
            rounds={otherRounds}
            series={series}
            stake={stake}
            spot={px}
            now={now}
            pricerSeeds={pricerSeeds}
            stateSeeds={stateSeeds}
            onPick={pickSide}
            disabled={!acct.owner || !!acct.busy}
          />

          <ResultsTape cadence={cadence} now={now} />
      </>

      <SimpleBetDrawer
        intent={betIntent}
        open={betOpen}
        onClose={() => setBetOpen(false)}
        stakeText={stakeText}
        setStakeText={setStakeText}
        presets={presets}
        spendable={spendable}
        now={now}
        pricerSeeds={pricerSeeds}
        busy={!!acct.busy}
        connected={!!acct.owner}
        needsAccount={!!acct.owner && !acct.wrapperExists}
        // Close FIRST, then hand off — so the review modal is never stacked on the sheet.
        onPlace={(pick) => {
          setBetOpen(false);
          requestPlace(pick);
        }}
      />

      {/* confirm */}
      {confirm && (
        <MintConfirmModal
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => doMint(confirm)}
          busy={acct.busy === 'mint'}
          headline={`BTC · ${confirm.isUp ? 'UP' : 'DOWN'}`}
          tone={confirm.isUp ? 'up' : 'down'}
          rows={reviewRows(confirm, cf?.chargesSkewFee ? { due: cf.skewFeeDue, bps: skewFee.feeBps } : undefined)}
          cost={usd(confirm.quote.stakeBase)}
          maxWin={usd(confirm.quote.winBase)}
          confirmLabel={`Bet ${confirm.isUp ? 'UP' : 'DOWN'} · ${usd(confirm.quote.stakeBase)}`}
          subtitle={
            acct.sessionCanTrade
              ? 'Instant trading is on — this places with no wallet pop-up.'
              : acct.gasless
                ? 'Signed in with Google — places instantly, no wallet pop-up.'
                : 'Review your bet, then approve it in your wallet.'
          }
          extra={<SessionOptInRow />}
        />
      )}

      {success && (
        <MintSuccessModal
          open
          onClose={() => setSuccess(null)}
          headline={success.headline}
          tone={success.tone}
          rows={success.rows}
          staked={success.staked}
          maxWin={success.maxWin}
          digest={success.digest}
          network={ACTIVE_NETWORK}
          positionsHref="/v2/portfolio"
        />
      )}
    </main>
  );
}

/**
 * The line in the headline question, highlighted as a chip and tinted by which way BTC
 * is MOVING — mint while it's climbing, coral while it's falling.
 *
 * NO caret. The number is the round's LOCKED line: it doesn't move, and an arrow sitting
 * on it read as though it did. Colour can carry a direction the value doesn't have —
 * an arrow can't — so the tint stays and the caret goes. Screen readers get the
 * direction from the label instead, since colour alone isn't a signal. `flat` stays
 * neutral, which is what keeps a quiet tape from strobing red/green (see `momentumOf`).
 */
function LinePill({ value, momentum }: { value: number; momentum: Momentum }) {
  const tone =
    momentum === 'up'
      ? 'border-up/35 bg-up/10 text-up'
      : momentum === 'down'
        ? 'border-down/35 bg-down/10 text-down'
        : 'border-(--line-soft) bg-bg-2 text-text-1';
  const label = momentum === 'up' ? 'Bitcoin is rising' : momentum === 'down' ? 'Bitcoin is falling' : 'Bitcoin is flat';
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 align-baseline font-mono text-[14px] font-semibold tabular-nums transition-colors sm:text-[17px] ${tone}`}
      title={label}
    >
      {price(value)}
      <span className="sr-only"> ({label})</span>
    </span>
  );
}

/** The confirm/success summary rows for a round bet. Names the ROUND, so a bet placed
 *  from a card is never ambiguous about which market it lands on. */
function reviewRows(pick: RoundPick, fee?: { due: bigint; bps: number }): ConfirmRow[] {
  const rows: ConfirmRow[] = [
    { label: 'Round', value: `${CADENCE_META[pick.cadence].short} · BTC` },
    { label: 'Your call', value: pick.isUp ? 'Closes ABOVE the strike' : 'Closes BELOW the strike' },
    { label: 'The strike', value: price(pick.line), emphasize: true },
  ];
  if (fee) rows.push({ label: `Skew fee (${(fee.bps / 100).toFixed(2)}%)`, value: usd(fee.due) });
  return rows;
}

/** What one call pays at the current amount — the win, not the multiplier. */
function PayoutCell({ isUp, q }: { isUp: boolean; q: SideQuote | null }) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className={`text-[9.5px] font-semibold uppercase tracking-wider ${isUp ? 'text-up' : 'text-down'}`}>
        {isUp ? 'Up' : 'Down'} wins
      </span>
      <span className="font-mono text-[13.5px] font-semibold tabular-nums text-text-1">
        {q && q.quotable ? `$${price(fromQuote(q.winBase))}` : '—'}
      </span>
    </span>
  );
}
