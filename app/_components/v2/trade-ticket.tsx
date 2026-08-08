'use client';

/**
 * V2TradeTicket — the trade ticket for the new deployment, in the right rail.
 * Mirrors the legacy FlowPanel's UI verbatim: same mono/terminal styling, same
 * guided two-step binary flow (① Side & level → ② Your bet, with a step bar,
 * "Set Amount" glass CTA, and a read-only recap on the bet step), built from
 * the shared ticket components (StepBar, DirectionToggle, GlassCta,
 * ReviewButton). Leverage is v2's addition and lives on the bet step next to
 * the stake. An external pick (surface node click, market-card Up/Down) jumps
 * straight to the bet step, exactly like legacy's surface/table/card picks.
 *
 * Reads the shared trade store (which market, mode, direction, strike/band,
 * stake, leverage) and the live Pricer for the selected market, then mints with
 * a one-click signed tx (auto-depositing any shortfall).
 *
 * Two modes (like legacy): Up/Down binary, and Range — a band (lower, higher]
 * that pays if BTC settles inside it. Range mirrors legacy's RangeTicket flow:
 * tap two price levels on the embedded odds curve to set the band (first tap
 * anchors, second closes it), then drag the edge handles to adjust — the curve
 * is the only band control, no steppers. Both size a position by a dollar
 * stake; leverage multiplies the max payout for the same stake. Cost is an
 * estimate (no public cost view in v2) — the wallet shows the exact figure and
 * the on-chain max_cost guard caps it.
 *
 * Mint goes through a review step (MintConfirmModal) then a celebratory success
 * modal (MintSuccessModal), reusing both deployment-agnostic components. No async
 * re-quote step: v2 pricing is synchronous off the live Pricer every render.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LuShare2 } from 'react-icons/lu';
import { usePredictAccountV2, qkV2Account } from '@/lib/hooks/use-predict-account-v2';
import { useStarterGrant } from '@/lib/hooks/use-starter-grant';
import { useV2TradeStore, STARTER_DEFAULT_STAKE, defaultStakeForBalance } from '@/lib/store/v2-trade-store';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { upFair, rangeFair, type SviFloat } from '@/lib/svi/svi';
import { fromFloat, toFloat, fromQuote, toQuote } from '@/config/scale';
import { dateUTC, countdown, pct, signed, quote as fmtQuote, leverage as fmtLev } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { starterGrant, STARTER_GRANT_BALANCE_CEILING } from '@/config/starter-grant';
import { isClosingSoon, isTooCloseToExpiry, cadenceOf } from '@/lib/markets/v2-discovery';
import {
  snapStrikeToAdmission,
  binaryTicks,
  rangeTicks,
  leverageScaled,
  maxCostWithSlippage,
} from '@/lib/sui/v2/ticks';
import { quantityForStake, winPayout, knockoutProbability, priceMoveToKnockout, leverageSliderMax, MIN_STAKE_BASE, mintAmountBase, minQuantityForBudget } from '@/lib/sui/v2/quote';
import { V2PayoutSlider } from './ticket/payout-slider';
import { V2LeverageSlider } from './ticket/leverage-slider';
import { V2SmileChart } from './smile-chart';
import { SharedTradeBanner } from './share/shared-trade-banner';
import { TradeShareModal } from './share/trade-share-modal';
import { InstantTradingToggle } from './session/instant-trading-toggle';
import { buildRecipe } from '@/lib/share/trade-link';
import { StepBar } from '@/app/_components/ticket/step-bar';
import { GlassError } from '@/app/_components/ui/glass-error';
import { DirectionToggle } from '@/app/_components/ticket/direction-toggle';
import { GlassCta } from '@/app/_components/ticket/glass-cta';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { TicketGuide } from '@/app/_components/ticket-guide';
import { TicketEmpty } from '@/app/_components/ticket-empty';
import { InfoTip } from '@/app/_components/ui/info-tip';
import { MintConfirmModal, type ConfirmRow } from '@/app/_components/mint-confirm-modal';
import { MintSuccessModal } from '@/app/_components/mint-success-modal';
import { SuccessModal } from '@/app/_components/ui/success-modal';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const SLIPPAGE_BPS = 100; // 1% cost-cap headroom (deposit sizing)
const AMOUNT_PRESETS = [1, 5, 10, 25];
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
// Compact payout multiple: full precision when small, but drop the decimals once
// it's large enough that they're just noise (and width) — 2.29× stays 2.29×, but
// 229.00× becomes 229× so a big-leverage ticket can't overflow the summary row.
const fmtMult = (m: number) =>
  `${(m >= 100 ? Math.round(m) : Number(m.toFixed(m >= 10 ? 1 : 2))).toLocaleString()}×`;

export function V2TradeTicket({
  market,
  pricer,
  serverNow,
  mobile = false,
  chart,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
  /** Mobile sheet: stay on step 1 (chart + strike) instead of jumping to the bet
   *  step on an external pick, and render `chart` at the top of binary step 1. */
  mobile?: boolean;
  chart?: ReactNode;
}) {
  const acct = usePredictAccountV2();
  const now = useNow(serverNow);
  const mounted = useMounted();
  const mode = useV2TradeStore((s) => s.mode);
  const setMode = useV2TradeStore((s) => s.setMode);
  const isUp = useV2TradeStore((s) => s.isUp);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const rangeLowerPrice = useV2TradeStore((s) => s.rangeLowerPrice);
  const rangeHigherPrice = useV2TradeStore((s) => s.rangeHigherPrice);
  const rangeAnchorPrice = useV2TradeStore((s) => s.rangeAnchorPrice);
  const setRangeBand = useV2TradeStore((s) => s.setRangeBand);
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);
  const leverage = useV2TradeStore((s) => s.leverage);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const pickSeq = useV2TradeStore((s) => s.pickSeq);
  const pulseFill = useV2TradeStore((s) => s.pulseFill);
  const pulseFocus = useV2TradeStore((s) => s.pulseFocus);
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);

  // First-run funding: a fresh wallet has no DUSDC (and, for external wallets, no
  // gas SUI). One tap drips a starter grant from the app treasury — the SAME
  // route/treasury as legacy (DUSDC is the same coin on both deployments), just
  // pointed at v2's wallet-balance query so the CTA below clears itself. Google/
  // Enoki accounts are gasless → DUSDC only; external wallets also get gas SUI.
  const grant = useStarterGrant(acct.owner ?? null, !acct.gasless, {
    invalidateKeys: acct.owner ? [qkV2Account.walletDusdc(acct.owner)] : [],
    symbol: predictV2Config.quote.symbol,
  });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [showCostDetails, setShowCostDetails] = useState(false);

  // The current trade as a shareable, ref-less recipe (the share modal folds in the
  // sender's name). Null until the config is complete enough to share: a range needs
  // both edges; a binary is shareable with or without a pinned strike. Guarded on
  // `market` because this runs before the no-market early return below.
  const shareBase = useMemo(
    () =>
      market
        ? buildRecipe({
            tenor: cadenceOf(market),
            mode,
            isUp,
            strike: strikePrice,
            lower: rangeLowerPrice,
            higher: rangeHigherPrice,
            stake,
            lev: leverage,
          })
        : null,
    [market, mode, isUp, strikePrice, rangeLowerPrice, rangeHigherPrice, stake, leverage],
  );
  // Two-step guided flow (legacy parity): 1 = side & level, 2 = bet (+ review
  // modal). An external pick (surface / market card) jumps straight to step 2.
  const [step, setStep] = useState<1 | 2>(1);
  // Stake as a raw editing buffer so the field can be empty / mid-edit (a
  // number-typed input coerces "" → 0, which makes a fresh digit read as "02").
  // The parsed number lives in the store for the sizing math. `null` = "not
  // edited yet, follow the store stake" — so the balance-aware default below
  // shows through the field without the effect having to write local state.
  const [betInput, setBetInput] = useState<string | null>(null);
  const shownBet = betInput ?? (stake > 0 ? String(stake) : '');
  const [mintSuccess, setMintSuccess] = useState<{
    headline: string;
    tone: 'up' | 'down';
    rows: ConfirmRow[];
    staked: string;
    maxWin: string;
    digest: string;
  } | null>(null);
  // The just-placed binary bet's spot, captured at mint and released when the
  // success modal closes — so the camera "make it pop" glide (FocusController)
  // lands as the trader returns to the surface, not wasted behind the modal.
  const revealFocus = useRef<{ marketId: string; strike: number; isUp: boolean } | null>(null);

  // Jump to the bet step on an external pick (surface node click, market-card
  // Up/Down) — the pick already chose side & level, so the next question is the
  // stake. Adjusted during render (React's documented "reset state on prop
  // change" pattern, same as legacy's selection sync). Seeding with the current
  // pickSeq means a value already in the store on mount is a leftover from a
  // prior visit, not a fresh pick — no jump. On mobile we stay on step 1 so the
  // trader lands on the price chart + strike first (legacy FlowPanel parity).
  const [appliedPick, setAppliedPick] = useState(pickSeq);
  if (pickSeq !== appliedPick) {
    setAppliedPick(pickSeq);
    if (mode === 'binary' && !mobile) setStep(2);
  }

  // One-time: right-size the default bet to what the wallet holds, once the
  // balance is known. Only fires while the stake is still the untouched $10
  // default — a trader who has already picked an amount is never overridden. The
  // "already ran" guard is a ref (not state) so it never re-renders on its own.
  const defaultSized = useRef(false);
  useEffect(() => {
    if (defaultSized.current || acct.walletDusdcBase === undefined) return; // wait for balance
    defaultSized.current = true;
    if (stake !== STARTER_DEFAULT_STAKE) return; // trader already chose an amount
    const sized = defaultStakeForBalance(acct.balanceBase + acct.walletDusdcBase);
    // Only the store stake changes; the field is `null` (untouched) so it shows
    // this new default through `shownBet` without a local state write.
    if (sized !== stake) setStake(sized);
  }, [acct.walletDusdcBase, acct.balanceBase, stake, setStake]);

  // Until mounted, the connected account is unknown (SSR has no wallet, but the
  // client restores it synchronously) — render a stable placeholder so the
  // server and first client paint match (no hydration mismatch); the real
  // ticket resolves right after hydration. Same pattern as legacy FlowPanel.
  if (!mounted) {
    return <div className="text-[12px] text-text-3">Loading trade ticket…</div>;
  }
  if (!acct.owner) {
    return <TicketEmpty />;
  }
  if (!market) {
    return <div className="card px-4 py-6 text-[13px] text-text-3">Pick a market to trade.</div>;
  }
  if (!pricer) {
    return <div className="card px-4 py-6 text-[13px] text-text-3">Loading live price…</div>;
  }

  const svi: SviFloat = pricer.svi;
  const admissionTickSize = BigInt(market.admission_tick_size);
  const admStep = toFloat(market.admission_tick_size);
  const atm = toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), admissionTickSize));

  const rangeMode = mode === 'range';
  const bandSet = rangeLowerPrice != null && rangeHigherPrice != null;
  // Absolute strikes — a picked level stays put as the forward moves (legacy
  // parity); until the user picks, default to the current ATM.
  const strike = strikePrice ?? atm;
  const lowerStrike = bandSet ? rangeLowerPrice : atm - admStep;
  const higherStrike = bandSet ? rangeHigherPrice : atm + admStep;
  const anchorStrike = rangeAnchorPrice;

  const upProb = upFair(strike, pricer.forward, svi);
  const binaryProb = isUp ? upProb : 1 - upProb;
  const rangeProb = rangeFair(lowerStrike, higherStrike, pricer.forward, svi);
  const entryProb = rangeMode ? rangeProb : binaryProb;

  // Cap on leverage from the protocol's PROBABILITY-SCALED admission curve — the
  // market-wide `max_admission_leverage` (e.g. 3×) is only the p→1 asymptote, so a
  // preset at it always aborts strike_exposure_config #6 at real odds. Clamp the
  // working value too, so a stale store pick can never mint above the live cap.
  const maxLev = leverageSliderMax(entryProb, toFloat(market.max_admission_leverage), market.expiry - now);
  const lev = Math.min(leverage, maxLev);

  // Leverage risk (verified from source, predict-testnet-6-24 — see
  // knockoutProbability/priceMoveToKnockout). The dollar loss is the SAME at any
  // leverage — a knocked-out order pays $0, so you always risk your whole stake;
  // what leverage changes is the safety margin. `knockoutProb` = the live chance
  // at which the position closes early; `knockoutMove` = how far the price can
  // move against you first (binary only — a range has no single adverse side).
  const liqLtv = toFloat(market.liquidation_ltv);
  const knockoutProb = knockoutProbability(entryProb, lev, liqLtv);
  const knockoutMove = rangeMode ? null : priceMoveToKnockout(strike, pricer.forward, svi, isUp, lev, liqLtv);
  // Present the buffer as a DOLLAR move first — it's always tangible and never
  // rounds to a broken-looking "0.0%" the way a percent does on short-tenor
  // markets (where the buffer is genuinely a few basis points). Percent rides
  // alongside with enough precision to stay non-zero.
  const knockoutMoveUsd = knockoutMove != null ? pricer.forward * knockoutMove : null;
  const knockoutMovePct =
    knockoutMove != null ? `${(knockoutMove * 100).toFixed(knockoutMove >= 0.001 ? 1 : 2)}%` : null;

  const stakeBase = toQuote(stake);
  // Budget mint: the chain derives the quantity from ITS live odds at execution,
  // so the user pays at most `amount` in premium no matter how the odds move
  // between quoting and landing. `quantity` is the quoted payout off the current
  // odds; minQuantity guards only against a violent gap (MAX_PAYOUT_SHRINK).
  const amount = mintAmountBase(stakeBase);
  const quantity = quantityForStake(amount, entryProb, lev); // quoted payout (chain sizes the real one)
  const minQuantity = minQuantityForBudget(quantity);
  // What a WIN actually pays: max payout minus the leverage floor (= full qty at
  // 1×). Fees below still charge on the notional `quantity`, not this.
  const winBase = winPayout(quantity, entryProb, lev);
  const feeBase = BigInt(Math.round(toFloat(market.base_fee) * Number(quantity)));
  const estCostBase = stakeBase + feeBase;
  const maxCost = maxCostWithSlippage(estCostBase, SLIPPAGE_BPS);

  // Ticks: range = two finite ticks; binary = one finite + a ±∞ sentinel.
  const { lowerTick, higherTick } = rangeMode
    ? rangeTicks(
        snapStrikeToAdmission(fromFloat(lowerStrike), admissionTickSize),
        snapStrikeToAdmission(fromFloat(higherStrike), admissionTickSize),
        BigInt(market.tick_size),
      )
    : binaryTicks(snapStrikeToAdmission(fromFloat(strike), admissionTickSize), isUp, BigInt(market.tick_size));

  // A level is priceable while its odds stay off the 0%/100% extremes; the
  // stake only gates the mint itself, not the level pick.
  const probOk = entryProb > 0.005 && entryProb < 0.995 && (!rangeMode || bandSet);
  // The chain rejects any mint whose stake (net premium, before fees) is under
  // $1 — strike_exposure_config's min_net_premium — so a sub-$1 bet must never
  // reach the wallet.
  const stakeTooSmall = stake > 0 && stakeBase < MIN_STAKE_BASE;
  const quotable = probOk && stakeBase >= MIN_STAKE_BASE;
  const shortfall = maxCost > acct.balanceBase ? maxCost - acct.balanceBase : 0n;
  const fundedFromAccount = estCostBase < acct.balanceBase ? estCostBase : acct.balanceBase;
  // Can the trade actually be funded? The mint auto-deposits the shortfall from
  // the wallet in the same transaction, so the real ceiling is account + wallet
  // DUSDC. If that's below the (slippage-padded) cost the deposit would revert,
  // so we block the review up front instead of letting the user walk into a
  // guaranteed on-chain failure. Only judged once the wallet balance is known
  // (undefined while loading) so it never flashes on first paint.
  const insufficientFunds =
    quotable &&
    acct.walletDusdcBase !== undefined &&
    maxCost > acct.balanceBase + acct.walletDusdcBase;

  // The trader's spendable DUSDC = trading account + wallet (the mint auto-deposits
  // any wallet shortfall), i.e. exactly what they can stake. Undefined until the
  // wallet balance loads, so the readout waits rather than flash an account-only
  // figure that then jumps.
  const spendableBase =
    acct.walletDusdcBase !== undefined ? acct.balanceBase + acct.walletDusdcBase : undefined;

  const closingSoon = isClosingSoon(market, now);
  const tooCloseToExpiry = isTooCloseToExpiry(market, now);

  const sym = predictV2Config.quote.symbol;
  const headline = `BTC · ${rangeMode ? 'RANGE' : isUp ? 'UP' : 'DOWN'}`;
  const tone: 'up' | 'down' = rangeMode || isUp ? 'up' : 'down';
  // Collapsed by default (legacy parity — keeps the card short). A shortfall is
  // NOT a blocker in v2: the wallet auto-deposits it in the same transaction and
  // the action button already says "Review deposit & mint", so unlike legacy's
  // insufficient-funds case there's nothing here that must never be hidden.
  const detailsOpen = showCostDetails;

  // Risk → reward (the money answer): what you pay now vs. the max win.
  // "You pay" headlines the STAKE the user picked ($10 stays $10 — user
  // feedback: the fee-inflated figure read as "I'm betting 10.40"); the
  // protocol fee itemizes in the cost breakdown instead. Net profit and the
  // payout multiple stay ALL-IN (stake + fee) so the money math never lies.
  const payDollars = fromQuote(stakeBase);
  const allInDollars = fromQuote(estCostBase);
  const winDollars = fromQuote(winBase);
  const mult = allInDollars > 0 ? winDollars / allInDollars : 0;
  const profit = winDollars - allInDollars;

  const outcomeRow: ConfirmRow = rangeMode
    ? { label: 'Outcome', value: 'Pays if price ends in the band' }
    : { label: 'Outcome', value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends AT/BELOW' };
  const levelRow: ConfirmRow = rangeMode
    ? { label: 'Band', value: `${usd(lowerStrike)}–${usd(higherStrike)}`, emphasize: true }
    : { label: 'Strike', value: usd(strike), emphasize: true };

  // Live step for the first-timer guide (legacy parity): binary tracks the real
  // step (3 = reviewing in the modal); range advances once a band exists.
  const guideStep: 1 | 2 | 3 = rangeMode ? (bandSet ? 2 : 1) : confirmOpen ? 3 : step;

  function applyBet(v: string) {
    // digits + a single optional decimal; empty allowed
    if (v === '' || /^\d*\.?\d*$/.test(v)) {
      setBetInput(v);
      setStake(Number(v) || 0);
    }
  }

  function openReview() {
    if (!quotable || tooCloseToExpiry || insufficientFunds || !!acct.busy) return;
    // Instant one-tap: a live session already removes the wallet pop-up. If the
    // trader opted in AND the trade needs no wallet top-up (shortfall covered by
    // the account), place it straight away and skip our review too. Never one-tap
    // a trade that would still open a deposit pop-up.
    if (acct.sessionActive && instantTrade && shortfall === 0n) {
      void handleMint();
      return;
    }
    setConfirmOpen(true);
  }

  // Set the range band from two typed prices (the faster alternative to tapping
  // the curve). Snap both to the admission grid so they're real mintable strikes,
  // and if they land on the same tick, push the upper one out by one tick so it's
  // always a real band. The store sorts low/high, so order typed doesn't matter.
  function setRangeFromInput(lo: number, hi: number) {
    const a = toFloat(snapStrikeToAdmission(fromFloat(lo), admissionTickSize));
    let b = toFloat(snapStrikeToAdmission(fromFloat(hi), admissionTickSize));
    if (a === b) b = a + admStep;
    setRangeBand(a, b);
  }

  async function handleMint() {
    // Turn instant trading on in THIS approval only when armed and none is live yet.
    const wasArming = armInstant && !acct.sessionActive;
    const digest = await acct.mintBudget(
      {
        marketId: market!.expiry_market_id,
        lowerTick,
        higherTick,
        amount,
        minQuantity,
        leverage: leverageScaled(lev),
        deposit: shortfall > 0n ? shortfall : undefined,
      },
      { silentSuccess: true, startSession: wasArming ? { duration: sessionDuration } : undefined },
    );
    setConfirmOpen(false);
    if (digest) {
      // Session is now live; disarm so a lapsed session later prompts to turn it back
      // on consciously rather than silently re-authorizing.
      if (wasArming) setArmInstant(false);
      // Ripple the fill on the surface (it reads the store's `fill`).
      pulseFill({
        marketId: market!.expiry_market_id,
        strike: rangeMode ? (lowerStrike + higherStrike) / 2 : strike,
        isUp: rangeMode ? true : isUp,
      });
      // Arm the camera "make it pop" reveal — the SAME glide Kelly uses when it
      // opens a trade — but fire it when the success modal CLOSES (below), so the
      // trader actually watches the camera land on their new position instead of
      // it playing out behind the modal. A range glides to its band midpoint (where
      // its live-PnL pin sits); a binary to its strike.
      revealFocus.current = rangeMode
        ? { marketId: market!.expiry_market_id, strike: (lowerStrike + higherStrike) / 2, isUp: true }
        : { marketId: market!.expiry_market_id, strike, isUp };
      setMintSuccess({
        headline,
        tone,
        rows: [
          outcomeRow,
          levelRow,
          { label: 'Expiry', value: dateUTC(market!.expiry) },
          ...(lev > 1 ? [{ label: 'Leverage', value: fmtLev(lev) }] : []),
          ...(feeBase > 0n ? [{ label: 'Protocol fee', value: `$${fromQuote(feeBase).toFixed(2)} ${sym}` }] : []),
        ],
        staked: `$${fromQuote(stakeBase).toFixed(2)} ${sym}`,
        maxWin: `$${fromQuote(winBase).toFixed(2)} ${sym}`,
        digest,
      });
    }
  }

  // ——— Bet-step sections, shared between binary step 2 and range mode ———

  const betSection = (
    <div className="flex flex-col gap-1.5">
      <Row label="Bet amount">
        <div className="ctrl-soft inline-flex items-center gap-1 rounded-md px-2 py-1 focus-within:border-white/20">
          <input
            type="text"
            inputMode="decimal"
            value={shownBet}
            placeholder="0"
            onChange={(e) => applyBet(e.target.value)}
            className="w-16 bg-transparent text-right text-text-1 outline-none"
            aria-label={`Bet amount in ${sym}`}
          />
          <span className="text-[10px] text-text-3">{sym}</span>
        </div>
      </Row>
      {/* How much the trader has to bet with — trading account + wallet, since the
          mint auto-deposits any wallet shortfall. Only shown once connected. */}
      {acct.owner && (
        <div className="-mt-0.5 flex justify-end text-[10px] tabular-nums text-text-3">
          <span>
            Balance{' '}
            <span className="text-text-2">
              {spendableBase !== undefined ? fromQuote(spendableBase).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '···'}
            </span>{' '}
            {sym}
          </span>
        </div>
      )}
      <div className="flex gap-1.5">
        {AMOUNT_PRESETS.map((n) => (
          <button
            key={n}
            onClick={() => applyBet(String(n))}
            className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
              Number(shownBet) === n ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
            }`}
          >
            ${n}
          </button>
        ))}
      </div>
      {stakeTooSmall && (
        <span className="text-[10px] leading-relaxed text-down">
          Minimum bet is $1.
        </span>
      )}
    </div>
  );

  // Continuous leverage slider (1× → the odds-scaled admission cap) — the
  // protocol admits any fractional multiple up to the cap, not just whole steps.
  const leverageSection = (
    <div className="flex flex-col gap-1.5">
      {maxLev > 1 ? (
        <V2LeverageSlider value={lev} max={maxLev} onChange={setLeverage} tone={tone} />
      ) : (
        <Row label="Leverage">
          <span className="text-[10px] text-text-3">1× only at these odds</span>
        </Row>
      )}
      {lev > 1 && knockoutProb != null && (
        <Row
          label={
            <span className="flex items-center gap-1.5">
              Max loss
              <InfoTip label="max loss with leverage">
                You can never lose more than your ${payDollars.toFixed(2)} — a losing leveraged bet
                closes early and pays $0. Leverage just shrinks your buffer:{' '}
                {knockoutMoveUsd != null && knockoutMoveUsd >= 1 ? (
                  <>
                    at {fmtLev(lev)}, a ~{usd(knockoutMoveUsd)} ({knockoutMovePct}) move in BTC{' '}
                    {isUp ? 'down' : 'up'} knocks you out.
                  </>
                ) : knockoutMove != null ? (
                  <>at {fmtLev(lev)}, even a tiny move in BTC {isUp ? 'down' : 'up'} knocks you out.</>
                ) : (
                  <>at {fmtLev(lev)}, it closes once your chance falls to about {pct(knockoutProb, 0)}.</>
                )}
              </InfoTip>
            </span>
          }
        >
          <span className="text-[11px] tabular-nums text-down">${payDollars.toFixed(2)}</span>
        </Row>
      )}
    </div>
  );

  // Risk → Reward: the answer to "what do I pay and what can I win?"
  const quoteCard = (
    <div className={`glass-card p-3.5 ${quotable && !tooCloseToExpiry ? (tone === 'up' ? 'up glow-accent' : 'down glow-down') : ''}`}>
      {tooCloseToExpiry ? (
        <span className="text-text-2">
          This market is about to settle — pick another market to trade.
        </span>
      ) : !probOk ? (
        <span className="text-text-2">
          {rangeMode ? 'Band' : 'Strike'} too far from spot to trade — pick a level nearer{' '}
          {usd(pricer.forward)} (only odds away from the 0%/100% extremes can be priced).
        </span>
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="eyebrow">You pay</span>
              <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="text-[22px] leading-none text-text-1">${payDollars.toFixed(2)}</span>
                <span className="text-[11px] leading-none text-text-3">{sym}</span>
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="eyebrow">You win</span>
              <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="text-[22px] leading-none text-up">${winDollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span className="text-[11px] leading-none text-text-3">{sym}</span>
                <span className="rounded bg-(--accent-soft) px-1.5 py-0.5 text-[10px] leading-none text-up">{fmtMult(mult)}</span>
              </span>
            </div>
          </div>
          <span className="mt-2 text-[10px] text-text-3">
            net profit if right <span className="text-up">{signed(profit)}</span>
          </span>

          <div className="mt-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="eyebrow">{rangeMode ? 'Band chance' : 'Implied chance'}</span>
              <span className="text-[12px] tabular-nums text-text-2">{pct(entryProb, 1)}</span>
            </div>
            <div className="meter">
              <i
                style={{
                  width: `${Math.min(100, Math.max(0, entryProb * 100))}%`,
                  background: tone === 'up' ? 'var(--up)' : 'var(--down)',
                }}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowCostDetails((v) => !v)}
            aria-expanded={detailsOpen}
            className="mt-3 flex items-center justify-between rounded-md px-1 py-1 text-[11px] text-text-3 transition-colors hover:text-text-2"
          >
            <span>Cost details</span>
            <span className="tabular-nums text-text-3">{detailsOpen ? '−' : '+'}</span>
          </button>
          {detailsOpen && (
            <div className="glass-inset mt-1 flex flex-col gap-2 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">Stake</span>
                <span className="text-[11px] tabular-nums text-text-1">${fromQuote(stakeBase).toFixed(2)}</span>
              </div>
              {feeBase > 0n && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-text-3">Protocol fee</span>
                    <span className="text-[11px] tabular-nums text-text-1">+${fromQuote(feeBase).toFixed(2)}</span>
                  </div>
                  {/* The all-in figure — reconciles the stake headline above with
                      what the wallet actually withdraws. */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-text-3">Total cost</span>
                    <span className="text-[11px] tabular-nums text-text-1">≈ ${allInDollars.toFixed(2)}</span>
                  </div>
                </>
              )}
              {/* The stake is a hard on-chain cap (budget mint) — only fees ride on top;
                  the row shows the deposit buffer that covers them. */}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">Deposit buffer (covers fees)</span>
                <span className="text-[11px] tabular-nums text-text-2">${fromQuote(maxCost).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">From your trading account</span>
                <span className="text-[11px] tabular-nums text-text-1">${fromQuote(fundedFromAccount).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">Deposit needed from wallet</span>
                <span className={`text-[11px] tabular-nums ${shortfall > 0n ? 'text-down' : 'text-text-1'}`}>${fromQuote(shortfall).toFixed(2)}</span>
              </div>
              {shortfall > 0n && (
                <span className="text-[10px] leading-relaxed text-text-3">
                  Not enough in your trading account — the shortfall deposits from your wallet in the same
                  transaction.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const betFooter = (
    <>
      {/* near-expiry caution — mint is blocked outright inside the cadence's final window */}
      {(closingSoon || tooCloseToExpiry) && (
        <div className="rounded border border-down/40 bg-down/10 p-2 text-[11px] leading-relaxed text-down">
          {tooCloseToExpiry
            ? 'Too close to expiry to mint — a transaction can’t land in time. Pick another market.'
            : `Closing in ${countdown(market.expiry, now)} — a mint may revert if the market settles before your transaction lands on-chain.`}
        </div>
      )}

      {/* Turn instant trading on inside this trade's approval (Slush, no live session). */}
      <InstantTradingToggle />
      <ActionButton acct={acct} tone={tone} quotable={quotable} stakeTooSmall={stakeTooSmall} tooCloseToExpiry={tooCloseToExpiry} onReview={openReview} shortfall={shortfall} insufficientFunds={insufficientFunds} />
      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
      <p className="text-[10px] leading-relaxed text-text-3">
        You’ll preview the trade next; cost is an estimate. Your wallet shows the exact amount
        before you approve.
      </p>
      {shareBase && (
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line py-2 text-[11px] font-medium text-text-2 transition-colors hover:border-white/20 hover:text-text-1"
        >
          <LuShare2 size={12} /> Share this trade with a friend
        </button>
      )}
    </>
  );

  // First-run funding CTA — legacy parity: a one-click app grant when enabled,
  // else the faucet link. Rendered at the top of the ticket (step-independent) so
  // a low-balance user sees it right away, in binary OR range, on either step.
  // Hidden the instant a grant succeeds this session so a freshly-funded user
  // can't re-tap it before the async balance refetch lands.
  // Offer the grant to any wallet that's empty across account + wallet. NOT gated
  // on "no trading account yet": creating a free gasless account doesn't fund you,
  // so a broke wallet with an account still needs this. The server self-heals stale
  // "already funded" markers, so a genuinely empty wallet claims; a really-funded
  // one is caught server side and falls back to the faucet (grant.failed → link).
  // (The balance check spans account + wallet so leftover funds in either counts.)
  const grantCta =
    acct.walletDusdcBase !== undefined &&
    acct.balanceBase + acct.walletDusdcBase < STARTER_GRANT_BALANCE_CEILING &&
    !grant.success ? (
      starterGrant.enabled && !grant.failed ? (
        <button
          onClick={grant.claim}
          disabled={grant.busy}
          className="glass-card px-3 py-2 text-left text-[11px] text-accent underline-offset-2 hover:underline disabled:opacity-50"
        >
          {grant.busy
            ? 'Funding your account…'
            : `New here? Get ${fmtQuote(fromQuote(starterGrant.displayBase))} ${sym} to start trading →`}
        </button>
      ) : predictV2Config.faucetUrl ? (
        <a
          href={predictV2Config.faucetUrl}
          target="_blank"
          rel="noreferrer"
          className="glass-card px-3 py-2 text-[11px] text-accent underline-offset-2 hover:underline"
        >
          Low balance — get testnet {sym} →
        </a>
      ) : null
    ) : null;

  return (
    <div className="flex flex-col gap-4 font-mono text-[12px] tabular-nums">
      <SharedTradeBanner />
      {grantCta}
      {/* Back to step 1 to change the strike (read-only on the bet step). Sits at
          the very top, above the guide, so it's the first thing on the bet step. */}
      {!rangeMode && step === 2 && (
        <button
          type="button"
          onClick={() => setStep(1)}
          className="-mb-1 inline-flex w-fit items-center gap-1.5 text-[12px] text-text-3 transition-colors hover:text-text-1"
        >
          <span aria-hidden className="text-[14px] leading-none">
            ←
          </span>
          Back to strike
        </button>
      )}

      {/* Plain-language "what do I do here" guide for first-timers (step-aware,
          and mode-aware so range traders aren't told to pick Up/Down). */}
      <TicketGuide
        step={guideStep}
        mode={rangeMode ? 'range' : 'binary'}
        storageKey="skew:v2-ticket-guide-dismissed"
        copy={{
          steps: [
            rangeMode ? 'Pick your price range on the odds curve' : 'Pick Up or Down and a price level',
            'Set your stake and leverage',
            'Review and confirm your trade',
          ],
          tip: rangeMode
            ? 'Tip: tap two price levels on the odds curve to set your band, then drag its edges to resize.'
            : 'Tip: click the surface or a market in the list to load it here.',
        }}
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 font-mono text-[11px] tabular-nums text-text-2">
            BTC · {dateUTC(market.expiry)} ·{' '}
            <span className={closingSoon || tooCloseToExpiry ? 'text-down' : 'text-text-3'}>
              {tooCloseToExpiry ? 'expired' : `${countdown(market.expiry, now)} left`}
            </span>
          </span>
        </div>

        {/* Binary (up/down) vs vertical-range mode. */}
        <div className="flex gap-1.5">
          {(['binary', 'range'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`flex-1 rounded-md py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                mode === m ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
              }`}
            >
              {m === 'binary' ? 'Up / Down' : 'Range'}
            </button>
          ))}
        </div>

        {rangeMode ? (
          !bandSet ? (
            // No band yet → tap two levels on the embedded odds curve (legacy
            // RangeTicket parity — self-contained, so it works wherever the rail
            // curve is out of reach).
            <>
              {/* Prominent instruction callout (accent bar + bright text) so it's
                  obvious how to build a range — not a faint grey line. */}
              <div className="flex items-start gap-2.5 rounded-lg border border-up/30 bg-(--accent-soft) p-2.5">
                <span aria-hidden className="mt-0.5 h-3.5 w-px shrink-0 bg-accent" />
                <p className="text-[12px] leading-relaxed text-text-1">
                  {anchorStrike != null ? (
                    <>
                      Lower level set at{' '}
                      <span className="tabular-nums text-accent">{usd(anchorStrike)}</span>, now tap
                      the <span className="text-accent">upper</span> price on the curve.
                    </>
                  ) : (
                    <>
                      <span className="text-accent">Type a low and high price</span> below, or tap
                      two levels on the curve, to bet BTC settles between them.
                    </>
                  )}
                </p>
              </div>
              {/* Fast path: type the two prices directly. Snaps to the grid + sets
                  the band, flipping to the same view a two-tap pick produces. */}
              <RangeManualInput atm={atm} admStep={admStep} onSet={setRangeFromInput} disabled={tooCloseToExpiry} />
              <V2SmileChart market={market} pricer={pricer} />
            </>
          ) : (
            <>
              <p className="text-[12px] leading-relaxed text-text-2">
                Win if <span className="text-text-1">BTC</span> settles{' '}
                <span className="text-up">between {usd(lowerStrike)} and {usd(higherStrike)}</span> at expiry.
              </p>

              {/* The band lives on the curve: drag either edge handle to adjust it
                  (works on touch too), tap elsewhere to re-pick, or Reset on the
                  chart. This is the only band control — no separate steppers. */}
              <V2SmileChart market={market} pricer={pricer} />

              {betSection}
              {leverageSection}
              {quoteCard}
              {betFooter}
            </>
          )
        ) : (
          <>
            <StepBar step={step} onStep={setStep} />

            {step === 1 ? (
              <>
                {/* Live price of this market (mobile sheet only) — read the movement
                    before betting. Strike/win-zone overlays track the slider live. */}
                {chart}
                <div className="flex gap-2">
                  <DirectionToggle active={isUp} tone="up" onClick={() => setIsUp(true)}>
                    UP
                  </DirectionToggle>
                  <DirectionToggle active={!isUp} tone="down" onClick={() => setIsUp(false)}>
                    DOWN
                  </DirectionToggle>
                </div>

                {/* Plain-language explainer so a first-time visitor understands the bet. */}
                <p className="text-[12px] leading-relaxed text-text-2">
                  Win if <span className="text-text-1">BTC</span> settles{' '}
                  <span className={isUp ? 'text-up' : 'text-down'}>
                    {isUp ? 'above' : 'at or below'} {usd(strike)}
                  </span>{' '}
                  at expiry.
                </p>

                {/* Strike as a PAYOUT slider — bounded to the quotable band, centered on
                    today's price; the exact strike + a ±1-tick nudge live on the slider. */}
                <V2PayoutSlider
                  forward={pricer.forward}
                  svi={svi}
                  isUp={isUp}
                  admStep={admStep}
                  admissionTickSize={admissionTickSize}
                  strike={strike}
                  onChange={setStrikePrice}
                  disabled={tooCloseToExpiry}
                />

                {!probOk && !tooCloseToExpiry && (
                  <p className="text-[12px] leading-relaxed text-text-2">
                    That strike is too far from spot to price — move it nearer{' '}
                    <span className="text-text-1">{usd(pricer.forward)}</span> to continue.
                  </p>
                )}

                <GlassCta onClick={() => setStep(2)} disabled={tooCloseToExpiry || !probOk}>
                  {tooCloseToExpiry ? 'Market expired' : 'Set Amount'}
                </GlassCta>
              </>
            ) : (
              <>
                {/* Entry recap — direction (tap the chip to flip UP/DOWN) and the chosen
                    strike (read-only; change it on step 1 via the back arrow up top). */}
                <div className="glass-inset flex flex-col gap-2.5 rounded-lg p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={`shrink-0 text-[11px] font-semibold uppercase tracking-wider ${isUp ? 'text-up' : 'text-down'}`}
                      >
                        {isUp ? '▲ UP' : '▼ DOWN'}
                      </span>
                      <span className="truncate text-[11px] text-text-3">
                        settles {isUp ? 'above' : 'at or below'}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsUp(!isUp)}
                      aria-label={`Switch to ${isUp ? 'DOWN' : 'UP'}`}
                      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                        isUp
                          ? 'border-down/30 text-down/70 hover:border-down/50 hover:text-down'
                          : 'border-up/30 text-up/70 hover:border-up/50 hover:text-up'
                      }`}
                    >
                      {isUp ? '▼ DOWN' : '▲ UP'}
                    </button>
                  </div>
                  {/* Strike is read-only here — it was set with the slider on step 1.
                      Go back to change it (the arrow above), so the level can't be
                      accidentally nudged at the bet step. */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-text-3">Strike</span>
                    <span className="font-mono text-[13px] tabular-nums text-text-1">{usd(strike)}</span>
                  </div>
                </div>

                {betSection}
                {leverageSection}
                {quoteCard}
                {betFooter}
              </>
            )}
          </>
        )}
      </div>

      <MintConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleMint}
        busy={acct.busy === 'mint' || acct.busy === 'create'}
        headline={headline}
        tone={tone}
        rows={[
          outcomeRow,
          levelRow,
          { label: 'Expiry', value: `${dateUTC(market.expiry)} · ${countdown(market.expiry, now)}` },
          ...(lev > 1 ? [{ label: 'Leverage', value: fmtLev(lev) }] : []),
          ...(feeBase > 0n ? [{ label: 'Protocol fee', value: `$${fromQuote(feeBase).toFixed(2)} ${sym}` }] : []),
        ]}
        cost={`$${fromQuote(stakeBase).toFixed(2)} ${sym}`}
        maxWin={`$${fromQuote(winBase).toFixed(2)} ${sym}`}
        confirmLabel={`Mint ${rangeMode ? 'Range' : isUp ? 'UP' : 'DOWN'}`}
        subtitle={
          acct.sessionActive
            ? acct.gasless
              ? 'Instant trading is on. This mints straight through, no sign step.'
              : 'Instant trading is on. This mints with no wallet pop-up.'
            : armInstant
              ? acct.gasless
                ? `This also turns on faster trades for ${sessionDuration === '7d' ? '7 days' : '24 hours'}, so your next trades skip the sign step.`
                : `This also turns on instant trading for ${sessionDuration === '7d' ? '7 days' : '24 hours'}, so you won’t need to approve again.`
              : acct.gasless
                ? 'Signed in with Google. Mints instantly, no wallet pop-up.'
                : 'Review your position, then approve it in your wallet'
        }
      />

      {mintSuccess && (
        <MintSuccessModal
          open={!!mintSuccess}
          onClose={() => {
            setMintSuccess(null);
            // Returning to the surface — glide the camera onto the bet just placed
            // so it clearly "lands", then rides live via its PnL pin. No-op on
            // mobile (FocusController is desktop-only) and for range bets.
            const f = revealFocus.current;
            revealFocus.current = null;
            if (f) pulseFocus(f);
          }}
          headline={mintSuccess.headline}
          tone={mintSuccess.tone}
          rows={mintSuccess.rows}
          staked={mintSuccess.staked}
          maxWin={mintSuccess.maxWin}
          digest={mintSuccess.digest}
          network={predictV2Config.network}
          positionsHref="/v2/portfolio"
          extraAction={
            shareBase ? (
              <button
                type="button"
                onClick={() => {
                  setMintSuccess(null);
                  setShareOpen(true);
                }}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-line py-2.5 text-[12px] font-medium text-text-1 transition-colors hover:border-white/20"
              >
                <LuShare2 size={13} /> Share this trade with a friend
              </button>
            ) : undefined
          }
        />
      )}

      <TradeShareModal open={shareOpen} onClose={() => setShareOpen(false)} base={shareBase} />

      {/* Starter-grant confirmation — a gasless, popup-less drip is easy to miss
          on a toast alone (mirrors legacy). */}
      <SuccessModal
        open={!!grant.success}
        onClose={grant.clearSuccess}
        title="Account funded"
        eyebrow="Received"
        amount={grant.success?.amount ?? 0}
        sub="added to your wallet — you’re ready to trade"
        gasNote={grant.success?.sui ? `+ ${grant.success.sui} SUI added for gas` : undefined}
        digest={grant.success?.digest}
      />
    </div>
  );
}

function ActionButton({
  acct,
  tone,
  quotable,
  stakeTooSmall,
  tooCloseToExpiry,
  onReview,
  shortfall,
  insufficientFunds,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  tone: 'up' | 'down';
  quotable: boolean;
  stakeTooSmall: boolean;
  tooCloseToExpiry: boolean;
  onReview: () => void;
  shortfall: bigint;
  insufficientFunds: boolean;
}) {
  if (!acct.wrapperExists)
    return (
      <ReviewButton tone="up" onClick={() => acct.createAccount()} disabled={!!acct.busy}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </ReviewButton>
    );
  return (
    <ReviewButton
      tone={tone}
      onClick={onReview}
      disabled={tooCloseToExpiry || !quotable || insufficientFunds || !!acct.busy}
    >
      {tooCloseToExpiry
        ? 'Too close to expiry'
        : stakeTooSmall
          ? 'Minimum bet is $1'
          : !quotable
            ? 'Adjust your level to quote'
            : acct.busy === 'mint' || acct.busy === 'deposit'
              ? 'Confirming…'
              : insufficientFunds
                ? 'Insufficient funds'
                : shortfall > 0n
                  ? 'Review deposit & mint'
                  : 'Review'}
    </ReviewButton>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-3">{label}</span>
      <span className="text-text-1">{children}</span>
    </div>
  );
}

/**
 * Type-a-range: two price inputs + Set, the fast alternative to tapping two points
 * on the odds curve. Local string state so a field can be empty / mid-edit; the
 * parent snaps to the admission grid and sorts low/high, so order and off-grid
 * values are fine. Set stays disabled until both are positive and distinct; Enter
 * in either field submits. Placeholders show example levels around the current
 * price so the expected input is obvious.
 */
function RangeManualInput({
  atm,
  admStep,
  onSet,
  disabled,
}: {
  atm: number;
  admStep: number;
  onSet: (lo: number, hi: number) => void;
  disabled?: boolean;
}) {
  const [lo, setLo] = useState('');
  const [hi, setHi] = useState('');
  const parse = (v: string): number | null => {
    if (!/^\d[\d,]*(?:\.\d+)?$/.test(v.trim())) return null;
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const loN = parse(lo);
  const hiN = parse(hi);
  const ready = !disabled && loN != null && hiN != null && loN !== hiN;
  const submit = () => {
    // Re-check inline (not via `ready`) so TS narrows loN/hiN to numbers here.
    if (disabled || loN == null || hiN == null || loN === hiN) return;
    onSet(loN, hiN);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  const field = (
    value: string,
    set: (v: string) => void,
    label: string,
    placeholder: string,
  ) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
      <div className="ctrl-soft flex items-center gap-1 rounded-md px-2 py-1.5 focus-within:border-white/20">
        <span className="text-[10px] text-text-3">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={`Range ${label.toLowerCase()} price`}
          className="w-full min-w-0 bg-transparent text-right font-mono tabular-nums text-text-1 outline-none placeholder:text-text-3/50"
        />
      </div>
    </label>
  );
  return (
    <div className="flex items-end gap-2">
      {field(lo, setLo, 'Low', Math.round(atm - 3 * admStep).toLocaleString('en-US'))}
      {field(hi, setHi, 'High', Math.round(atm + 3 * admStep).toLocaleString('en-US'))}
      <button
        type="button"
        onClick={submit}
        disabled={!ready}
        className={`shrink-0 rounded-md px-3 py-2 text-[11px] font-medium uppercase tracking-wider transition-colors ${
          ready ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3 opacity-60'
        }`}
      >
        Set
      </button>
    </div>
  );
}
