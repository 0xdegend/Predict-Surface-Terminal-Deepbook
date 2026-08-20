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
