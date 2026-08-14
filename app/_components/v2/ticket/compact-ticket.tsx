'use client';

/**
 * V2CompactTicket — the tight, self-contained trade ticket shared by the surface
 * click-to-mint popover AND the co-pilot's pop-out modal. It's the SHORT ticket:
 * a one-line header, a mini Up/Down, a two-view glance→ticket split (so each view
 * stays small), a compact quote card, and the full mint → confirm → success flow.
 *
 * Extracted from the surface popover so both entry points render exactly the same
 * short ticket (no duplicated pricing/mint logic). The surface wraps it in a
 * centered card over the canvas; the co-pilot wraps it in the shared Modal and
 * opens straight on the bet view (`initialView="ticket"`), since the co-pilot has
 * already picked side + level and the next question is just the amount.
 *
 * It's a thin consumer of the SAME synchronous pricing the rail ticket uses —
 * entry probability off the live SVI/forward, `quantityForStake` sizing, the
 * on-chain max_cost / max_probability guards — and the same shared store, so the
 * rail, the popover and this modal never disagree on the trade. Cost is an
 * estimate (no public cost view in v2); the wallet shows the exact figure at
 * signing.
 */
import { useEffect, useRef, useState } from 'react';
import { GlassError } from '../../ui/glass-error';
import { LuArrowLeft } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2TradeStore, STARTER_DEFAULT_STAKE, defaultStakeForBalance } from '@/lib/store/v2-trade-store';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { upFair, rangeFair } from '@/lib/svi/svi';
import { toFloat, fromFloat, fromQuote, toQuote } from '@/config/scale';
import { price, pct, signed, countdown, dateUTC, leverage as fmtLev } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { isClosingSoon, isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import {
  snapStrikeToAdmission,
  binaryTicks,
  rangeTicks,
  leverageScaled,
  maxCostWithSlippage,
} from '@/lib/sui/v2/ticks';
import {
  quantityForStake,
  winPayout,
  leverageSliderMax,
  MIN_STAKE_BASE,
  mintAmountBase,
  minQuantityForBudget,
} from '@/lib/sui/v2/quote';
import { V2PayoutSlider } from './payout-slider';
import { V2LeverageSlider } from './leverage-slider';
import { SessionOptInRow } from '../session/session-opt-in-row';
import { MintConfirmModal, type ConfirmRow } from '@/app/_components/mint-confirm-modal';
import { MintSuccessModal } from '@/app/_components/mint-success-modal';
import type { SmileInput } from '@/lib/svi/surface';
import type { V2Market } from '@/lib/api/v2/types';

/** The frozen recap a successful mint shows in the MintSuccessModal (parity with
 *  the rail ticket) — captured at mint time so it never re-renders behind it. */
type MintSuccessState = {
  headline: string;
  tone: 'up' | 'down';
  rows: ConfirmRow[];
  staked: string;
  maxWin: string;
  digest: string;
};

const SLIPPAGE_BPS = 100; // 1% deposit-buffer headroom (same as the rail ticket)
const AMOUNT_PRESETS = [1, 5, 10, 25];
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** The mint sizing shared by both bodies — mirrors the rail ticket line-for-line. */
function sizeTrade(market: V2Market, entryProb: number, stake: number, leverage: number) {
  // Cap by the protocol's PROBABILITY-SCALED admission curve, not the market-wide
  // `max_admission_leverage` — that ceiling (e.g. 3×) is only the p→1 asymptote, so
  // offering it at real odds always aborts with strike_exposure_config #6. The
  // slider exposes the fractional headroom up to this cap (continuous on-chain).
  const maxLev = leverageSliderMax(entryProb, toFloat(market.max_admission_leverage), market.expiry - Date.now());
  const lev = Math.min(leverage, maxLev);
  const stakeBase = toQuote(Math.max(0, stake));
  // Budget mint: the chain derives the quantity at execution from its own live
  // odds — the premium can never exceed `amount`. `quantity` is the quoted
  // payout; minQuantity aborts only on a violent gap (MAX_PAYOUT_SHRINK).
  const amount = mintAmountBase(stakeBase);
  const quantity = quantityForStake(amount, entryProb, lev); // quoted payout (chain sizes the real one)
  const minQuantity = minQuantityForBudget(quantity);
  // What a WIN actually pays: max payout minus the leverage floor (= full qty at
  // 1×). Fees still charge on the notional `quantity`, not this.
  const win = winPayout(quantity, entryProb, lev);
  const feeBase = BigInt(Math.round(toFloat(market.base_fee) * Number(quantity)));
  const estCostBase = stakeBase + feeBase;
  const maxCost = maxCostWithSlippage(estCostBase, SLIPPAGE_BPS);
  return { maxLev, lev, stakeBase, quantity, win, amount, minQuantity, feeBase, estCostBase, maxCost };
}

export function V2CompactTicket({
  market,
  input,
  now,
  onClose,
  initialView,
}: {
  market: V2Market | null;
  input: SmileInput | null;
  now: number;
  onClose: () => void;
  /** Which binary sub-view to open on. The surface popover opens on 'glance'
   *  (pick the strike first); the co-pilot modal opens on 'ticket' (side + level
   *  are already chosen, so the next step is the amount). */
  initialView?: 'glance' | 'ticket';
}) {
  const mode = useV2TradeStore((s) => s.mode);
  const acct = usePredictAccountV2();
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);

  // Same one-time balance-aware default as the full ticket (shared store), so the
  // co-pilot / surface popover also opens on an amount a small wallet can cover,
  // not a preselected $10 it has to clear. Only while the stake is untouched. The
  // "already ran" guard is a ref (not state) so it never re-renders on its own.
  const defaultSized = useRef(false);
  useEffect(() => {
    if (defaultSized.current || acct.walletDusdcBase === undefined) return; // wait for balance
    defaultSized.current = true;
    if (stake !== STARTER_DEFAULT_STAKE) return; // trader already chose an amount
    const sized = defaultStakeForBalance(acct.balanceBase + acct.walletDusdcBase);
    if (sized !== stake) setStake(sized);
  }, [acct.walletDusdcBase, acct.balanceBase, stake, setStake]);

  return (
    <div className="font-mono text-[12px] tabular-nums">
      {mode === 'range' ? (
        <RangeBody market={market} input={input} now={now} onClose={onClose} />
      ) : (
        <BinaryBody market={market} input={input} now={now} onClose={onClose} initialView={initialView} />
      )}
    </div>
  );
}

/* ─────────────────────────── binary (up / down) ─────────────────────────── */

function BinaryBody({
  market,
  input,
  now,
  onClose,
  initialView = 'glance',
}: {
  market: V2Market | null;
  input: SmileInput | null;
  now: number;
  onClose: () => void;
  initialView?: 'glance' | 'ticket';
}) {
  const acct = usePredictAccountV2();
  const isUp = useV2TradeStore((s) => s.isUp);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const setMode = useV2TradeStore((s) => s.setMode);
  const pickRangeLevel = useV2TradeStore((s) => s.pickRangeLevel);
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);
  const leverage = useV2TradeStore((s) => s.leverage);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const pulseFill = useV2TradeStore((s) => s.pulseFill);
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);

  const [view, setView] = useState<'glance' | 'ticket'>(initialView);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mintSuccess, setMintSuccess] = useState<MintSuccessState | null>(null);

  if (!market || !input) {
    return <div className="px-3.5 py-3 text-[11px] text-text-3">Loading market…</div>;
  }

  const { svi, forward } = input;
  const admissionTickSize = BigInt(market.admission_tick_size);
  const admStep = toFloat(market.admission_tick_size) || 1;
  const atm = toFloat(snapStrikeToAdmission(fromFloat(forward), admissionTickSize));
  // Absolute strike — a picked level stays put as the price moves; default to ATM.
  const strike = strikePrice ?? atm;

  const upProb = upFair(strike, forward, svi);
  const entryProb = isUp ? upProb : 1 - upProb;
  const probOk = entryProb > 0.005 && entryProb < 0.995;

  const closingSoon = isClosingSoon(market, now);
  const expired = isTooCloseToExpiry(market, now);

  const s = sizeTrade(market, entryProb, stake, leverage);
  // stakeBase must clear the chain's $1 min_net_premium or the mint aborts.
  const quotable = probOk && s.stakeBase >= MIN_STAKE_BASE && !expired;
  const shortfall = s.maxCost > acct.balanceBase ? s.maxCost - acct.balanceBase : 0n;

  // Switch this market into the range builder, seeding the just-clicked strike
  // as the first edge — the user clicks one more node to complete the band.
  function switchToRange() {
    pickRangeLevel(strike);
    setMode('range');
  }

  function openReview() {
    if (!quotable || acct.busy) return;
    // Instant one-tap when a session is live and the trade is fully account-funded
    // (a wallet top-up would still pop up, so never one-tap that).
    if (acct.sessionCanTrade && instantTrade && shortfall === 0n) {
      void handleMint();
      return;
    }
    setConfirmOpen(true);
  }

  async function handleMint() {
    const { lowerTick, higherTick } = binaryTicks(
      snapStrikeToAdmission(fromFloat(strike), admissionTickSize),
      isUp,
      BigInt(market!.tick_size),
    );
    // silentSuccess: the celebratory MintSuccessModal replaces the toast (rail parity).
    // Turn instant trading on in THIS approval only when armed and none is live yet.
    const wasArming = armInstant && !acct.sessionActive;
    const digest = await acct.mintBudget(
      {
        marketId: market!.expiry_market_id,
        lowerTick,
        higherTick,
        amount: s.amount,
        minQuantity: s.minQuantity,
        leverage: leverageScaled(s.lev),
        deposit: shortfall > 0n ? shortfall : undefined,
      },
      { silentSuccess: true, startSession: wasArming ? { duration: sessionDuration } : undefined },
    );
    setConfirmOpen(false);
    if (digest) {
      // Disarm now the session is live; a later lapse prompts to turn it back on.
      if (wasArming) setArmInstant(false);
      pulseFill({ marketId: market!.expiry_market_id, strike, isUp });
      // Keep the ticket mounted behind the success modal; it closes on Done.
      setMintSuccess({
        headline: `BTC · ${isUp ? 'UP' : 'DOWN'}`,
        tone: isUp ? 'up' : 'down',
        rows: confirmRows(
          { label: 'Outcome', value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends AT/BELOW' },
          { label: 'Strike', value: usd(strike), emphasize: true },
          market!,
          now,
          s,
        ),
        staked: `$${fromQuote(s.stakeBase).toFixed(2)} ${predictV2Config.quote.symbol}`,
        maxWin: `$${fromQuote(s.win).toFixed(2)} ${predictV2Config.quote.symbol}`,
        digest,
      });
    }
  }

  return (
    <div className="flex flex-col">
      <PopoverHeader expiry={market.expiry} now={now} expired={expired} />

      {/* Up / Down */}
      <div className="flex gap-1.5 px-3 pt-2.5">
        <MiniToggle active={isUp} tone="up" onClick={() => setIsUp(true)}>
          ▲ UP
        </MiniToggle>
        <MiniToggle active={!isUp} tone="down" onClick={() => setIsUp(false)}>
          ▼ DOWN
        </MiniToggle>
      </div>

      {/* Glance: strike + odds */}
      <div className="flex items-end justify-between px-3.5 pt-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{isUp ? 'Settles above' : 'Settles at/below'}</span>
          <span className="font-mono text-[20px] leading-none tabular-nums text-text-1">
            {price(strike)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums">
          <span className={isUp ? 'text-up' : 'text-text-3'}>UP {pct(upProb, 1)}</span>
          <span className={!isUp ? 'text-down' : 'text-text-3'}>DN {pct(1 - upProb, 1)}</span>
        </div>
      </div>

      {view === 'glance' ? (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
          {/* Slide to adjust the strike without re-clicking the surface. */}
          <div className="px-0.5 pb-1">
            <V2PayoutSlider
              forward={forward}
              svi={svi}
              isUp={isUp}
              admStep={admStep}
              admissionTickSize={admissionTickSize}
              strike={strike}
              onChange={setStrikePrice}
              disabled={expired}
            />
          </div>
          {!probOk && (
            <p className="px-0.5 text-[10.5px] leading-snug text-text-3">
              This strike is too far from spot to price — pick one nearer the colored ridge.
            </p>
          )}
          <button
            type="button"
            onClick={() => setView('ticket')}
            disabled={!probOk || expired}
            className={`rounded-lg border py-2.5 text-[12px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:text-text-3 ${
              isUp
                ? 'border-up/50 bg-(--accent-soft) text-up hover:bg-up/15'
                : 'border-down/50 bg-(--down-soft) text-down hover:bg-down/15'
            }`}
          >
            {expired ? 'Market expired' : 'Preview trade'}
          </button>
          <button
            type="button"
            onClick={switchToRange}
            className="text-[10.5px] text-text-3 underline-offset-2 transition-colors hover:text-text-2"
          >
            or bet a price range instead
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
          <button
            type="button"
            onClick={() => setView('glance')}
            className="flex items-center gap-1 self-start text-[10.5px] text-text-3 transition-colors hover:text-text-2"
          >
            <LuArrowLeft size={11} /> change strike
          </button>

          <BetRow stake={stake} setStake={setStake} />
          {s.maxLev > 1 && (
            <V2LeverageSlider value={s.lev} max={s.maxLev} onChange={setLeverage} tone={isUp ? 'up' : 'down'} />
          )}

          <QuoteCard s={s} quotable={quotable} probOk={probOk} expired={expired} isUp={isUp} shortfall={shortfall} />

          {closingSoon && !expired && (
            <p className="rounded border border-down/40 bg-down/10 px-2 py-1 text-[10px] leading-tight text-down">
              Closes in {countdown(market.expiry, now)} — may revert if it settles first.
            </p>
          )}

          {/* Faster-trades opt-in moved into the confirm dialog (SessionOptInRow via
              MintConfirmModal's `extra`), so this short ticket stays short. */}
          <MintButton
            tone={isUp ? 'up' : 'down'}
            busy={acct.busy === 'mint'}
            disabled={!quotable || !!acct.busy}
            needsAccount={!acct.wrapperExists}
            owner={acct.owner ?? null}
            creating={acct.busy === 'create'}
            onCreate={() => acct.createAccount()}
            onReview={openReview}
            shortfall={shortfall}
            oneTap={acct.sessionCanTrade && instantTrade && shortfall === 0n}
          />
          {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
        </div>
      )}

      <MintConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleMint}
        busy={acct.busy === 'mint'}
        headline={`BTC · ${isUp ? 'UP' : 'DOWN'}`}
        tone={isUp ? 'up' : 'down'}
        rows={confirmRows(
          { label: 'Outcome', value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends AT/BELOW' },
          { label: 'Strike', value: usd(strike), emphasize: true },
          market,
          now,
          s,
        )}
        cost={`$${fromQuote(s.stakeBase).toFixed(2)} ${predictV2Config.quote.symbol}`}
        maxWin={`$${fromQuote(s.win).toFixed(2)} ${predictV2Config.quote.symbol}`}
        confirmLabel={`Mint ${isUp ? 'UP' : 'DOWN'}`}
        subtitle={
          acct.sessionCanTrade
            ? acct.gasless
              ? 'Instant trading is on. This mints straight through, no sign step.'
              : 'Instant trading is on. This mints with no wallet pop-up.'
            : acct.gasless
              ? 'Signed in with Google. Mints instantly, no wallet pop-up.'
              : 'Review your position, then approve it in your wallet'
        }
        extra={<SessionOptInRow />}
      />

      {mintSuccess && (
        <MintSuccessModal
          open={!!mintSuccess}
          onClose={() => {
            setMintSuccess(null);
            onClose();
          }}
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

/* ─────────────────────────────── range ──────────────────────────────────── */

function RangeBody({
  market,
  input,
  now,
  onClose,
}: {
  market: V2Market | null;
  input: SmileInput | null;
  now: number;
  onClose: () => void;
}) {
  const acct = usePredictAccountV2();
  const rangeLowerPrice = useV2TradeStore((s) => s.rangeLowerPrice);
  const rangeHigherPrice = useV2TradeStore((s) => s.rangeHigherPrice);
  const rangeAnchorPrice = useV2TradeStore((s) => s.rangeAnchorPrice);
  const clearRange = useV2TradeStore((s) => s.clearRange);
  const setMode = useV2TradeStore((s) => s.setMode);
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);
  const leverage = useV2TradeStore((s) => s.leverage);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const pulseFill = useV2TradeStore((s) => s.pulseFill);
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mintSuccess, setMintSuccess] = useState<MintSuccessState | null>(null);

  if (!market || !input) {
    return <div className="px-3.5 py-3 text-[11px] text-text-3">Loading market…</div>;
  }

  const { svi, forward } = input;
  const admissionTickSize = BigInt(market.admission_tick_size);
  const admStep = toFloat(market.admission_tick_size) || 1;
  const atm = toFloat(snapStrikeToAdmission(fromFloat(forward), admissionTickSize));

  const bandSet = rangeLowerPrice != null && rangeHigherPrice != null;
  const lower = bandSet ? rangeLowerPrice : atm - admStep;
  const higher = bandSet ? rangeHigherPrice : atm + admStep;

  const entryProb = rangeFair(lower, higher, forward, svi);
  const probOk = entryProb > 0.005 && entryProb < 0.995;

  const closingSoon = isClosingSoon(market, now);
  const expired = isTooCloseToExpiry(market, now);

  const s = sizeTrade(market, entryProb, stake, leverage);
  // stakeBase must clear the chain's $1 min_net_premium or the mint aborts.
  const quotable = bandSet && probOk && s.stakeBase >= MIN_STAKE_BASE && !expired;
  const shortfall = s.maxCost > acct.balanceBase ? s.maxCost - acct.balanceBase : 0n;

  function openReview() {
    if (!quotable || acct.busy) return;
    // Instant one-tap when a session is live and the trade is fully account-funded
    // (a wallet top-up would still pop up, so never one-tap that).
    if (acct.sessionCanTrade && instantTrade && shortfall === 0n) {
      void handleMint();
      return;
    }
    setConfirmOpen(true);
  }

  async function handleMint() {
    const { lowerTick, higherTick } = rangeTicks(
      snapStrikeToAdmission(fromFloat(lower), admissionTickSize),
      snapStrikeToAdmission(fromFloat(higher), admissionTickSize),
      BigInt(market!.tick_size),
    );
    // silentSuccess: the celebratory MintSuccessModal replaces the toast (rail parity).
    // Turn instant trading on in THIS approval only when armed and none is live yet.
    const wasArming = armInstant && !acct.sessionActive;
    const digest = await acct.mintBudget(
      {
        marketId: market!.expiry_market_id,
        lowerTick,
        higherTick,
        amount: s.amount,
        minQuantity: s.minQuantity,
        leverage: leverageScaled(s.lev),
        deposit: shortfall > 0n ? shortfall : undefined,
      },
      { silentSuccess: true, startSession: wasArming ? { duration: sessionDuration } : undefined },
    );
    setConfirmOpen(false);
    if (digest) {
      // Disarm now the session is live; a later lapse prompts to turn it back on.
      if (wasArming) setArmInstant(false);
      pulseFill({ marketId: market!.expiry_market_id, strike: (lower + higher) / 2, isUp: true });
      // Keep the ticket mounted behind the success modal; it closes on Done.
      setMintSuccess({
        headline: 'BTC · RANGE',
        tone: 'up',
        rows: confirmRows(
          { label: 'Outcome', value: 'Pays if price ends in the band' },
          { label: 'Band', value: `${usd(lower)}–${usd(higher)}`, emphasize: true },
          market!,
          now,
          s,
        ),
        staked: `$${fromQuote(s.stakeBase).toFixed(2)} ${predictV2Config.quote.symbol}`,
        maxWin: `$${fromQuote(s.win).toFixed(2)} ${predictV2Config.quote.symbol}`,
        digest,
      });
    }
  }

  return (
    <div className="flex flex-col">
      <PopoverHeader expiry={market.expiry} now={now} expired={expired} mode="Range" />

      {!bandSet ? (
        // Defensive — the canvas keeps this card unmounted while a band is still
        // being drawn, so this only shows if the band was cleared underneath us.
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-3">
          <p className="text-[11px] leading-relaxed text-text-2">
            {rangeAnchorPrice != null
              ? `First edge set at ${price(rangeAnchorPrice)}. Click another point on the surface to complete the band.`
              : 'Click two points on the surface to bet BTC settles between them.'}
          </p>
          <button
            type="button"
            onClick={() => setMode('binary')}
            className="self-start text-[10.5px] text-text-3 underline-offset-2 transition-colors hover:text-text-2"
          >
            ← back to Up / Down
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
          <div className="flex items-center justify-between px-0.5">
            <span className="eyebrow">Settles between</span>
            <button
              type="button"
              onClick={clearRange}
              className="ctrl-soft rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-3"
            >
              reset
            </button>
          </div>
          <div className="glass-inset flex items-center justify-between px-3 py-2 font-mono text-[13px] tabular-nums text-text-1">
            <span>{price(lower)}</span>
            <span className="text-text-3">—</span>
            <span>{price(higher)}</span>
          </div>

          <BetRow stake={stake} setStake={setStake} />
          {s.maxLev > 1 && (
            <V2LeverageSlider value={s.lev} max={s.maxLev} onChange={setLeverage} tone="up" />
          )}

          <QuoteCard s={s} quotable={quotable} probOk={probOk} expired={expired} isUp shortfall={shortfall} />

          {closingSoon && !expired && (
            <p className="rounded border border-down/40 bg-down/10 px-2 py-1 text-[10px] leading-tight text-down">
              Closes in {countdown(market.expiry, now)} — may revert if it settles first.
            </p>
          )}

          {/* Faster-trades opt-in moved into the confirm dialog (SessionOptInRow via
              MintConfirmModal's `extra`), so this short ticket stays short. */}
          <MintButton
            tone="up"
            busy={acct.busy === 'mint'}
            disabled={!quotable || !!acct.busy}
            needsAccount={!acct.wrapperExists}
            owner={acct.owner ?? null}
            creating={acct.busy === 'create'}
            onCreate={() => acct.createAccount()}
            onReview={openReview}
            shortfall={shortfall}
            oneTap={acct.sessionCanTrade && instantTrade && shortfall === 0n}
          />
          {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
        </div>
      )}

      <MintConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleMint}
        busy={acct.busy === 'mint'}
        headline="BTC · RANGE"
        tone="up"
        rows={confirmRows(
          { label: 'Outcome', value: 'Pays if price ends in the band' },
          { label: 'Band', value: `${usd(lower)}–${usd(higher)}`, emphasize: true },
          market,
          now,
          s,
        )}
        cost={`$${fromQuote(s.stakeBase).toFixed(2)} ${predictV2Config.quote.symbol}`}
        maxWin={`$${fromQuote(s.win).toFixed(2)} ${predictV2Config.quote.symbol}`}
        confirmLabel="Mint Range"
        subtitle={
          acct.sessionCanTrade
            ? acct.gasless
              ? 'Instant trading is on. This mints straight through, no sign step.'
              : 'Instant trading is on. This mints with no wallet pop-up.'
            : acct.gasless
              ? 'Signed in with Google. Mints instantly, no wallet pop-up.'
              : 'Review your position, then approve it in your wallet'
        }
        extra={<SessionOptInRow />}
      />

      {mintSuccess && (
        <MintSuccessModal
          open={!!mintSuccess}
          onClose={() => {
            setMintSuccess(null);
            onClose();
          }}
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

/* ───────────────────────────── shared bits ──────────────────────────────── */

function confirmRows(
  outcome: ConfirmRow,
  level: ConfirmRow,
  market: V2Market,
  now: number,
  s: ReturnType<typeof sizeTrade>,
): ConfirmRow[] {
  return [
    outcome,
    level,
    { label: 'Expiry', value: `${dateUTC(market.expiry)} · ${countdown(market.expiry, now)}` },
    ...(s.lev > 1 ? [{ label: 'Leverage', value: fmtLev(s.lev) }] : []),
    ...(s.feeBase > 0n
      ? [{ label: 'Protocol fee', value: `$${fromQuote(s.feeBase).toFixed(2)} ${predictV2Config.quote.symbol}` }]
      : []),
  ];
}

function PopoverHeader({
  expiry,
  now,
  expired,
  mode,
}: {
  expiry: number;
  now: number;
  expired: boolean;
  mode?: string;
}) {
  return (
    <div className="head-divider flex items-center gap-2 px-3.5 py-2.5 pr-8">
      <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">BTC</span>
      {mode && <span className="text-[9px] uppercase tracking-wider text-accent">{mode}</span>}
      <span
        className={`ml-auto font-mono text-[10px] tabular-nums ${expired ? 'text-down' : 'text-text-3'}`}
      >
        {expired ? 'expired' : `${countdown(expiry, now)} left`}
      </span>
    </div>
  );
}

function BetRow({ stake, setStake }: { stake: number; setStake: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-3">Bet</span>
      <div className="ml-auto flex gap-1.5">
        {AMOUNT_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setStake(n)}
            className={`min-w-7 rounded-md px-2 py-1 text-[11px] tabular-nums transition-colors ${
              stake === n ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
            }`}
          >
            ${n}
          </button>
        ))}
      </div>
    </div>
  );
}

function QuoteCard({
  s,
  quotable,
  probOk,
  expired,
  isUp,
  shortfall,
}: {
  s: ReturnType<typeof sizeTrade>;
  quotable: boolean;
  probOk: boolean;
  expired: boolean;
  isUp: boolean;
  shortfall: bigint;
}) {
  const sym = predictV2Config.quote.symbol;
  const glow = quotable ? (isUp ? 'up glow-accent' : 'down glow-down') : '';

  let body: React.ReactNode;
  if (expired) {
    body = <span className="text-text-3">This market is about to settle — pick another market.</span>;
  } else if (!probOk) {
    body = (
      <span className="text-text-3">
        Too far from spot to price — pick a level nearer the colored ridge.
      </span>
    );
  } else if (s.stakeBase < MIN_STAKE_BASE) {
    body = <span className="text-text-3">Minimum bet is $1 — pick a bigger amount.</span>;
  } else {
    const pay = fromQuote(s.stakeBase);
    const allIn = fromQuote(s.estCostBase);
    const win = fromQuote(s.win);
    const mult = allIn > 0 ? win / allIn : 0;
    const profit = win - allIn;
    body = (
      <div className="flex flex-col">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="eyebrow">You pay</span>
            <span className="flex items-baseline gap-1">
              <span className="font-mono text-[19px] leading-none tabular-nums text-text-1">
                {pay.toFixed(2)}
              </span>
              <span className="text-[10px] text-text-3">{sym}</span>
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="eyebrow">You win</span>
            <span className="flex items-baseline gap-1">
              <span className="font-mono text-[19px] leading-none tabular-nums text-up">
                {win.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              <span className="rounded bg-(--accent-soft) px-1 py-0.5 text-[9px] leading-none text-up">
                {mult.toFixed(2)}×
              </span>
            </span>
          </div>
        </div>
        <span className="mt-1.5 text-[10px] text-text-3">
          net if right <span className="text-up">{signed(profit)}</span>
          {s.feeBase > 0n && <> · fee +${fromQuote(s.feeBase).toFixed(2)}</>}
        </span>
        {shortfall > 0n && (
          <span className="mt-1.5 text-[9.5px] leading-tight text-text-3">
            +${fromQuote(shortfall).toFixed(2)} from your wallet, same transaction.
          </span>
        )}
        <span className="mt-1.5 text-[9.5px] leading-tight text-text-3">
          Estimate — exact cost shown before you confirm.
        </span>
      </div>
    );
  }

  return <div className={`glass-card p-3 font-mono text-[11px] tabular-nums ${glow}`}>{body}</div>;
}

function MintButton({
  tone,
  busy,
  disabled,
  needsAccount,
  owner,
  creating,
  onCreate,
  onReview,
  shortfall,
  oneTap,
}: {
  tone: 'up' | 'down';
  busy: boolean;
  disabled: boolean;
  needsAccount: boolean;
  owner: string | null;
  creating: boolean;
  onCreate: () => void;
  onReview: () => void;
  shortfall: bigint;
  /** One-tap will place directly (no review modal) → the button says "Confirm", not "Review". */
  oneTap: boolean;
}) {
  if (!owner) {
    return (
      <div className="glass-inset rounded-lg py-2.5 text-center text-[11px] text-text-3">
        Connect a wallet (top-right) to trade
      </div>
    );
  }
  if (needsAccount) {
    return (
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="rounded-lg border border-up/40 bg-(--accent-soft) py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:opacity-50"
      >
        {creating ? 'creating account…' : 'Create trading account first'}
      </button>
    );
  }
  const toneCls =
    tone === 'up'
      ? 'border-up/50 from-up/25 to-up/10 text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:from-up/35'
      : 'border-down/50 from-down/25 to-down/10 text-down shadow-[0_0_22px_-8px_rgba(240,121,107,0.3)] hover:from-down/35';
  return (
    <button
      type="button"
      onClick={onReview}
      disabled={disabled}
      className={`flex items-center justify-center gap-2 rounded-lg border bg-linear-to-b px-3 py-2.5 text-[12px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none ${toneCls}`}
    >
      {busy && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
      )}
      {busy ? 'Confirming…' : shortfall > 0n ? 'Review deposit & mint' : oneTap ? 'Confirm' : 'Review'}
    </button>
  );
}

function MiniToggle({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'up' | 'down';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const activeCls =
    tone === 'up'
      ? 'border border-up/50 bg-(--accent-soft) text-up'
      : 'border border-down/50 bg-(--down-soft) text-down';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-lg py-2 text-[12px] font-semibold tracking-wide transition-all ${
        active ? activeCls : 'ctrl-soft text-text-3'
      }`}
    >
      {children}
    </button>
  );
}
