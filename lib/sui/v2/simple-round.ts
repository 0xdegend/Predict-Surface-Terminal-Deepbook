/**
 * lib/sui/v2/simple-round.ts — the pure trade math behind simple mode's UP/DOWN
 * round view. Pins the round's LINE to the market's on-chain reference tick and
 * quotes each side off the live pricer, at 1x, reusing the same sizing the full
 * ticket uses (so a simple bet and an advanced bet on the same market agree).
 *
 * Kept side-effect-free so it's unit-testable without a chain. See [[simple-mode]].
 */
import { toFloat, fromFloat, toQuote } from '@/config/scale';
import {
  tickToStrike,
  snapStrikeToAdmission,
  binaryTicks,
  maxCostWithSlippage,
  type TickRange,
} from '@/lib/sui/v2/ticks';
import { fairUp, type LivePricer } from '@/lib/sui/v2/pricer';
import {
  quantityForStake,
  winPayout,
  mintAmountBase,
  minQuantityForBudget,
  MIN_STAKE_BASE,
} from '@/lib/sui/v2/quote';
import type { V2Market } from '@/lib/api/v2/types';

/** Simple mode always trades at 1x with the ticket's 1% deposit-buffer slippage. */
export const SIMPLE_SLIPPAGE_BPS = 100;
/** Odds band a side must sit inside to be quotable (the chain gates ~1%..99%). */
const MIN_QUOTE_PROB = 0.005;
const MAX_QUOTE_PROB = 0.995;

/**
 * The round's LINE (the single strike everyone bets above/below), 1e9-scaled.
 * Pinned to the market's on-chain `reference_tick` when it's set (the short 1m/5m
 * rounds), falling back to the at-the-money forward (snapped to the admission
 * grid) when it isn't (hourly, or a brand-new market). `reference_tick` is a tick
 * INDEX — price via `tickToStrike` (verified live, see [[simple-mode]]).
 */
export function roundLineScaled(
  referenceTick: number | string | null | undefined,
  forward: number,
  tickSize: bigint | string | number,
  admissionTickSize: bigint | string | number,
): { lineScaled: bigint; pinned: boolean } {
  if (referenceTick != null && referenceTick !== '') {
    return { lineScaled: tickToStrike(BigInt(referenceTick), tickSize), pinned: true };
  }
  return { lineScaled: snapStrikeToAdmission(fromFloat(forward), admissionTickSize), pinned: false };
}

/**
 * Is a line still worth betting BOTH ways? True while the fair odds sit inside
 * `margin`..`1 - margin`.
 *
 * `margin` is deliberately looser than the chain's hard quotable gate (0.5%): by the
 * time a side is literally unquotable the round has been a one-way bet for a long
 * while, so we move the line before that, not at it.
 */
export function lineIsTradeable(pricer: LivePricer, lineScaled: bigint, margin = 0.05): boolean {
  const p = fairUp(pricer, toFloat(lineScaled));
  return p > margin && p < 1 - margin;
}

export interface LineChoice {
  lineScaled: bigint;
  /** True while this is the round's on-chain reference tick. */
  pinned: boolean;
  /** True when we left a pinned line behind because it stopped being a two-way bet. */
  moved: boolean;
}

/**
 * Which line this round should offer right now.
 *
 * WHY A ROUND'S LINE CAN MOVE. The line is fixed at the round's open, so a sharp move
 * can leave it several sigma away with most of the clock still to run: UP is then worth
 * ~1.00 and DOWN ~0.00, and BOTH sides fail the mintable gate at the same instant. A
 * live census found that state in 8 of 18 sampled pinned rounds, including a 1-minute
 * round dead with 36s left and a 5-minute round dead with 96s left
 * ([[simple-round.live.test]]). A trader who lands then has nothing to trade.
 *
 * Predict prices a continuous strike ladder on the SAME expiry, so the fix is to offer a
 * strike back at the money. That is a real binary settling against its own strike, not a
 * substitute for the round's reference — a position minted here settles correctly. The
 * hourly tab has always worked this way (it has no reference tick), which is exactly why
 * it never goes dead; this extends the same behaviour to the pinned tabs.
 *
 * TWO RULES THAT KEEP THE NUMBER STILL:
 *
 *   1. Moving is ONE-WAY. Once a round has moved we never fall back to the pinned line,
 *      even if spot returns, or the headline would bounce every time it crossed the
 *      margin.
 *   2. A moved line is re-anchored only when it in turn stops being a two-way bet, and
 *      only if the money has actually moved off it (`!== atmScaled`) — without that
 *      guard a lopsided line already sitting at the money would re-pick forever.
 */
export function chooseRoundLine(
  pricer: LivePricer,
  atmScaled: bigint,
  pinnedScaled: bigint | null,
  heldScaled: bigint | null,
): LineChoice {
  if (heldScaled != null) {
    const spent = !lineIsTradeable(pricer, heldScaled) && heldScaled !== atmScaled;
    return { lineScaled: spent ? atmScaled : heldScaled, pinned: false, moved: pinnedScaled != null };
  }
  if (pinnedScaled != null && lineIsTradeable(pricer, pinnedScaled)) {
    return { lineScaled: pinnedScaled, pinned: true, moved: false };
  }
  return { lineScaled: atmScaled, pinned: false, moved: pinnedScaled != null };
}

export interface SideQuote {
  isUp: boolean;
  /** Fair entry probability of this side winning (0..1). */
  entryProb: number;
  /** Payout ÷ stake (≈ 1 / entryProb at 1x). */
  multiplier: number;
  /** DUSDC won if the side is right (base units) — full quantity at 1x. */
  winBase: bigint;
  stakeBase: bigint;
  /** `mint_exact_amount` budget (base units). */
  amount: bigint;
  /** The odds-drift guard for the budget mint. */
  minQuantity: bigint;
  /** Upper cost bound (base units) for funding math. */
  maxCost: bigint;
  ticks: TickRange;
  /** True when the odds are inside the priceable band AND the stake clears the min. */
  quotable: boolean;
}

/** Quote one side (UP or DOWN) of the round at the pinned line, at 1x. */
export function quoteSide(
  market: Pick<V2Market, 'tick_size' | 'base_fee'>,
  pricer: LivePricer,
  lineScaled: bigint,
  stake: number,
  isUp: boolean,
): SideQuote {
  const line = toFloat(lineScaled);
  const upProb = fairUp(pricer, line);
  const entryProb = isUp ? upProb : 1 - upProb;
  const stakeBase = toQuote(Math.max(0, stake));
  const amount = mintAmountBase(stakeBase);
  const quantity = quantityForStake(amount, entryProb, 1);
  const minQuantity = minQuantityForBudget(quantity);
  const winBase = winPayout(quantity, entryProb, 1); // = quantity at 1x
  const feeBase = BigInt(Math.round(toFloat(market.base_fee) * Number(quantity)));
  const maxCost = maxCostWithSlippage(stakeBase + feeBase, SIMPLE_SLIPPAGE_BPS);
  const multiplier = stakeBase > 0n ? Number(winBase) / Number(stakeBase) : 0;
  const ticks = binaryTicks(lineScaled, isUp, market.tick_size);
  const quotable =
    entryProb > MIN_QUOTE_PROB && entryProb < MAX_QUOTE_PROB && stakeBase >= MIN_STAKE_BASE;
  return { isUp, entryProb, multiplier, winBase, stakeBase, amount, minQuantity, maxCost, ticks, quotable };
}
