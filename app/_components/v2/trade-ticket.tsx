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
 * that pays if BTC settles inside it. Both size a position by a dollar stake;
 * leverage multiplies the max payout for the same stake. Cost is an estimate
 * (no public cost view in v2) — the wallet shows the exact figure and the
 * on-chain max_cost guard caps it.
 *
 * Mint goes through a review step (MintConfirmModal) then a celebratory success
 * modal (MintSuccessModal), reusing both deployment-agnostic components. No async
 * re-quote step: v2 pricing is synchronous off the live Pricer every render.
 */
import { useEffect, useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { upFair, rangeFair, type SviFloat } from '@/lib/svi/svi';
import { fromFloat, toFloat, fromQuote, toQuote } from '@/config/scale';
import { dateUTC, countdown, pct, signed } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { isClosingSoon, isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import {
  snapStrikeToAdmission,
  binaryTicks,
  rangeTicks,
  leverageScaled,
  maxProbabilityWithSlippage,
  maxCostWithSlippage,
} from '@/lib/sui/v2/ticks';
import { quantityForStake, defaultRangeBandOffsets } from '@/lib/sui/v2/quote';
import { V2PayoutSlider } from './ticket/payout-slider';
import { StepBar } from '@/app/_components/ticket/step-bar';
import { DirectionToggle } from '@/app/_components/ticket/direction-toggle';
import { GlassCta } from '@/app/_components/ticket/glass-cta';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { TicketGuide } from '@/app/_components/ticket-guide';
import { TicketEmpty } from '@/app/_components/ticket-empty';
import { MintConfirmModal, type ConfirmRow } from '@/app/_components/mint-confirm-modal';
import { MintSuccessModal } from '@/app/_components/mint-success-modal';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const SLIPPAGE_BPS = 100; // 1% cost-cap headroom
const AMOUNT_PRESETS = [1, 5, 10, 25];
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function V2TradeTicket({
  market,
  pricer,
  serverNow,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
}) {
  const acct = usePredictAccountV2();
  const now = useNow(serverNow);
  const mounted = useMounted();
  const mode = useV2TradeStore((s) => s.mode);
  const setMode = useV2TradeStore((s) => s.setMode);
  const isUp = useV2TradeStore((s) => s.isUp);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  const setStrikeOffset = useV2TradeStore((s) => s.setStrikeOffset);
  const rangeLowerOffset = useV2TradeStore((s) => s.rangeLowerOffset);
  const rangeHigherOffset = useV2TradeStore((s) => s.rangeHigherOffset);
  const setRangeBand = useV2TradeStore((s) => s.setRangeBand);
  const nudgeRangeEdge = useV2TradeStore((s) => s.nudgeRangeEdge);
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);
  const leverage = useV2TradeStore((s) => s.leverage);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const pickSeq = useV2TradeStore((s) => s.pickSeq);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showCostDetails, setShowCostDetails] = useState(false);
  // Two-step guided flow (legacy parity): 1 = side & level, 2 = bet (+ review
  // modal). An external pick (surface / market card) jumps straight to step 2.
  const [step, setStep] = useState<1 | 2>(1);
  // Stake as a raw string so the field can be empty / mid-edit (a number-typed
  // input coerces "" → 0, which makes a fresh digit read as "02"). The parsed
  // number lives in the store for the sizing math.
  const [betInput, setBetInput] = useState(() => (stake > 0 ? String(stake) : ''));
  const [mintSuccess, setMintSuccess] = useState<{
    headline: string;
    tone: 'up' | 'down';
    rows: ConfirmRow[];
    staked: string;
    maxWin: string;
    digest: string;
  } | null>(null);

  // Jump to the bet step on an external pick (surface node click, market-card
  // Up/Down) — the pick already chose side & level, so the next question is the
  // stake. Adjusted during render (React's documented "reset state on prop
  // change" pattern, same as legacy's selection sync). Seeding with the current
  // pickSeq means a value already in the store on mount is a leftover from a
  // prior visit, not a fresh pick — no jump.
  const [appliedPick, setAppliedPick] = useState(pickSeq);
  if (pickSeq !== appliedPick) {
    setAppliedPick(pickSeq);
    if (mode === 'binary') setStep(2);
  }

  // Seed a sensible default band the first time range mode is used on this
  // market (band width scales with the market's IV/tenor — see the helper).
  useEffect(() => {
    if (mode !== 'range' || !market || !pricer) return;
    if (rangeLowerOffset != null && rangeHigherOffset != null) return;
    const step = toFloat(market.admission_tick_size) || 1;
    const atm = toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), BigInt(market.admission_tick_size)));
    const { lower, higher } = defaultRangeBandOffsets(pricer.forward, atm, pricer.svi, market.expiry, Date.now(), step);
    setRangeBand(lower, higher);
  }, [mode, market, pricer, rangeLowerOffset, rangeHigherOffset, setRangeBand]);

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
  const bandSet = rangeLowerOffset != null && rangeHigherOffset != null;
  const strike = atm + strikeOffset * admStep;
  const lowerStrike = bandSet ? atm + rangeLowerOffset * admStep : atm - admStep;
  const higherStrike = bandSet ? atm + rangeHigherOffset * admStep : atm + admStep;

  const upProb = upFair(strike, pricer.forward, svi);
  const binaryProb = isUp ? upProb : 1 - upProb;
  const rangeProb = rangeFair(lowerStrike, higherStrike, pricer.forward, svi);
  const entryProb = rangeMode ? rangeProb : binaryProb;

  // Market cap on leverage; clamp the working value so a stale store pick
  // (e.g. 3× kept across a switch to a 2×-max market) can never mint above it.
  const maxLev = Math.max(1, Math.floor(toFloat(market.max_admission_leverage)));
  const lev = Math.min(leverage, maxLev);

  // Knockout barrier (verified from source, predict-testnet-6-24:
  // strike_exposure_config::assert_mint_admission sets floor F = p·qty·(1−1/L);
  // strike_exposure::liquidate_order_if_under_floor closes when qty·P ≤ F/ltv).
  // So the position is knocked out when the side's live chance P falls to
  // p_entry·(1−1/L)/ltv. 1× has F = 0 → never liquidated. Liquidated orders
  // pay $0 ("tombstones clear with zero payout").
  const liqLtv = toFloat(market.liquidation_ltv);
  const knockoutProb = lev > 1 && liqLtv > 0 ? (entryProb * (1 - 1 / lev)) / liqLtv : null;

  const stakeBase = toQuote(stake);
  const quantity = quantityForStake(stakeBase, entryProb, lev); // max payout base units
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
  const maxProbability = maxProbabilityWithSlippage(fromFloat(entryProb), SLIPPAGE_BPS, BigInt(market.max_entry_probability));

  // A level is priceable while its odds stay off the 0%/100% extremes; the
  // stake only gates the mint itself, not the level pick.
  const probOk = entryProb > 0.005 && entryProb < 0.995 && (!rangeMode || bandSet);
  const quotable = probOk && stake > 0;
  const shortfall = maxCost > acct.balanceBase ? maxCost - acct.balanceBase : 0n;
  const fundedFromAccount = estCostBase < acct.balanceBase ? estCostBase : acct.balanceBase;

  const closingSoon = isClosingSoon(market, now);
  const tooCloseToExpiry = isTooCloseToExpiry(market, now);

  const sym = predictV2Config.quote.symbol;
  const headline = `BTC · ${rangeMode ? 'RANGE' : isUp ? 'UP' : 'DOWN'}`;
  const tone: 'up' | 'down' = rangeMode || isUp ? 'up' : 'down';
  const detailsOpen = showCostDetails || shortfall > 0n;

  // Risk → reward (the money answer): what you pay now vs. the max win.
  const payDollars = fromQuote(estCostBase);
  const winDollars = fromQuote(quantity);
  const mult = payDollars > 0 ? winDollars / payDollars : 0;
  const profit = winDollars - payDollars;

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
    if (!quotable || tooCloseToExpiry || !!acct.busy) return;
    setConfirmOpen(true);
  }

  async function handleMint() {
    const digest = await acct.mint(
      {
        marketId: market!.expiry_market_id,
        lowerTick,
        higherTick,
        quantity,
        leverage: leverageScaled(lev),
        maxCost,
        maxProbability,
        deposit: shortfall > 0n ? shortfall : undefined,
      },
      { silentSuccess: true },
    );
    setConfirmOpen(false);
    if (digest) {
      setMintSuccess({
        headline,
        tone,
        rows: [
          outcomeRow,
          levelRow,
          { label: 'Expiry', value: dateUTC(market!.expiry) },
          ...(lev > 1 ? [{ label: 'Leverage', value: `${lev}×` }] : []),
        ],
        staked: `$${fromQuote(estCostBase).toFixed(2)} ${sym}`,
        maxWin: `$${fromQuote(quantity).toFixed(2)} ${sym}`,
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
            value={betInput}
            placeholder="0"
            onChange={(e) => applyBet(e.target.value)}
            className="w-16 bg-transparent text-right text-text-1 outline-none"
            aria-label={`Bet amount in ${sym}`}
          />
          <span className="text-[10px] text-text-3">{sym}</span>
        </div>
      </Row>
      <div className="flex gap-1.5">
        {AMOUNT_PRESETS.map((n) => (
          <button
            key={n}
            onClick={() => applyBet(String(n))}
            className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
              Number(betInput) === n ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
            }`}
          >
            ${n}
          </button>
        ))}
      </div>
    </div>
  );

  // Leverage as a preset row (1× … max), matching the bet-amount presets above
  // it — the market only admits a handful of whole multiples, so buttons beat a
  // slider.
  const leverageSection = (
    <div className="flex flex-col gap-1.5">
      <Row label="Leverage">
        <span className="text-[10px] text-text-3">multiplies your payout</span>
      </Row>
      <div className="flex gap-1.5">
        {Array.from({ length: maxLev }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            onClick={() => setLeverage(n)}
            aria-pressed={lev === n}
            className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
              lev === n ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
            }`}
          >
            {n}×
          </button>
        ))}
      </div>
      {lev > 1 && knockoutProb != null && (
        <div className="glass-inset flex flex-col gap-2 rounded-lg p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-text-3">Max loss</span>
            <span className="text-[11px] tabular-nums text-down">
              ${payDollars.toFixed(2)} <span className="text-text-3">(all you pay)</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-text-3">Knocked out at</span>
            <span className="text-[11px] tabular-nums text-text-1">≈ {pct(knockoutProb, 1)} chance</span>
          </div>
          <span className="text-[10px] leading-relaxed text-text-3">
            {lev}× the payout for the same stake — you can never lose more than you pay. The
            trade-off: if your side&rsquo;s live chance drops from {pct(entryProb, 1)} to about{' '}
            {pct(knockoutProb, 1)}, the position is closed early and pays $0 — even if the price
            recovers before expiry.
          </span>
        </div>
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
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">You pay</span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-[22px] leading-none text-text-1">${payDollars.toFixed(2)}</span>
                <span className="text-[11px] leading-none text-text-3">{sym}</span>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">You win</span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-[22px] leading-none text-up">${winDollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span className="text-[11px] leading-none text-text-3">{sym}</span>
                <span className="rounded bg-(--accent-soft) px-1.5 py-0.5 text-[10px] leading-none text-up">{mult.toFixed(2)}×</span>
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
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-text-3">Protocol fee</span>
                  <span className="text-[11px] tabular-nums text-text-1">+${fromQuote(feeBase).toFixed(2)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">Cost cap (slippage)</span>
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

      <ActionButton acct={acct} tone={tone} quotable={quotable} tooCloseToExpiry={tooCloseToExpiry} onReview={openReview} shortfall={shortfall} />
      {acct.error && <p className="text-[11px] leading-relaxed text-down">{acct.error}</p>}
      <p className="text-[10px] leading-relaxed text-text-3">
        You’ll preview the trade next; cost is an estimate — your wallet shows the exact amount
        before you approve.
      </p>
    </>
  );

  return (
    <div className="flex flex-col gap-4 font-mono text-[12px] tabular-nums">
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
            ? 'Tip: drag the band edges on the odds curve below to resize.'
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
          <>
            <p className="text-[12px] leading-relaxed text-text-2">
              Win if <span className="text-text-1">BTC</span> settles{' '}
              <span className="text-up">between {usd(lowerStrike)} and {usd(higherStrike)}</span> at expiry.
            </p>
            <RangeEdge label="Lower price" value={usd(lowerStrike)} onDown={() => nudgeRangeEdge('lower', -1)} onUp={() => nudgeRangeEdge('lower', 1)} />
            <RangeEdge label="Higher price" value={usd(higherStrike)} onDown={() => nudgeRangeEdge('higher', -1)} onUp={() => nudgeRangeEdge('higher', 1)} />
            <p className="text-[11px] leading-relaxed text-text-3">Drag the band edges on the odds curve below to resize.</p>

            {betSection}
            {leverageSection}
            {quoteCard}
            {betFooter}
          </>
        ) : (
          <>
            <StepBar step={step} onStep={setStep} />

            {step === 1 ? (
              <>
                <div className="flex gap-2">
                  <DirectionToggle active={isUp} tone="up" onClick={() => setIsUp(true)} sub={pct(upProb, 1)}>
                    UP
                  </DirectionToggle>
                  <DirectionToggle active={!isUp} tone="down" onClick={() => setIsUp(false)} sub={pct(1 - upProb, 1)}>
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
                  atm={atm}
                  admStep={admStep}
                  admissionTickSize={admissionTickSize}
                  strikeOffset={strikeOffset}
                  onChange={setStrikeOffset}
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
          ...(lev > 1 ? [{ label: 'Leverage', value: `${lev}×` }] : []),
          ...(feeBase > 0n ? [{ label: 'Protocol fee', value: `$${fromQuote(feeBase).toFixed(2)} ${sym}` }] : []),
        ]}
        cost={`$${fromQuote(estCostBase).toFixed(2)} ${sym}`}
        maxWin={`$${fromQuote(quantity).toFixed(2)} ${sym}`}
        confirmLabel={`Mint ${rangeMode ? 'Range' : isUp ? 'UP' : 'DOWN'}`}
        subtitle={
          acct.gasless
            ? 'Signed in with Google — mints instantly, no wallet pop-up'
            : 'Review your position, then approve it in your wallet'
        }
      />

      {mintSuccess && (
        <MintSuccessModal
          open={!!mintSuccess}
          onClose={() => setMintSuccess(null)}
          headline={mintSuccess.headline}
          tone={mintSuccess.tone}
          rows={mintSuccess.rows}
          staked={mintSuccess.staked}
          maxWin={mintSuccess.maxWin}
          digest={mintSuccess.digest}
          network={predictV2Config.network}
          positionsHref="/v2/portfolio"
        />
      )}
    </div>
  );
}

function ActionButton({
  acct,
  tone,
  quotable,
  tooCloseToExpiry,
  onReview,
  shortfall,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  tone: 'up' | 'down';
  quotable: boolean;
  tooCloseToExpiry: boolean;
  onReview: () => void;
  shortfall: bigint;
}) {
  if (!acct.wrapperExists)
    return (
      <ReviewButton tone="up" onClick={() => acct.createAccount()} disabled={!!acct.busy}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </ReviewButton>
    );
  return (
    <ReviewButton tone={tone} onClick={onReview} disabled={tooCloseToExpiry || !quotable || !!acct.busy}>
      {tooCloseToExpiry
        ? 'Too close to expiry'
        : !quotable
          ? 'Adjust your level to quote'
          : acct.busy === 'mint' || acct.busy === 'deposit'
            ? 'Confirming…'
            : shortfall > 0n
              ? 'Review deposit & mint'
              : 'Review'}
    </ReviewButton>
  );
}

function RangeEdge({ label, value, onDown, onUp }: { label: string; value: string; onDown: () => void; onUp: () => void }) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-1">
        <button onClick={onDown} className="ctrl-soft h-6 w-6 rounded-md text-[13px] text-text-2 transition-colors hover:text-text-1">
          −
        </button>
        <span className="min-w-20 text-center font-mono text-[13px] tabular-nums text-text-1">{value}</span>
        <button onClick={onUp} className="ctrl-soft h-6 w-6 rounded-md text-[13px] text-text-2 transition-colors hover:text-text-1">
          +
        </button>
      </div>
    </Row>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-3">{label}</span>
      <span className="text-text-1">{children}</span>
    </div>
  );
}
