/**
 * lib/sui/v2/budget-mint.ts — assemble the parameters for a binary "budget" mint
 * (`mint_exact_amount`) from a bet's plain inputs (strike, direction, stake,
 * leverage). This is the SAME sizing the trade tickets do inline (compact-ticket's
 * `sizeTrade` + the entry-probability + tick math), pulled out so the co-pilot can
 * place a bet from chat through the exact same numbers — one source of truth, so
 * a chat-placed bet and a ticket-placed one can never size differently.
 *
 * Pure (no React, no fetch, no signing). The caller passes the plan's `mint`
 * fields to `acct.mintBudget`, computing `deposit` from its own balance.
 */
import { toFloat, fromFloat, toQuote } from '@/config/scale';
import { snapStrikeToAdmission, binaryTicks, leverageScaled, maxCostWithSlippage } from './ticks';
import { quantityForStake, leverageSliderMax, minQuantityForBudget, mintAmountBase, MIN_STAKE_BASE } from './quote';
import { upFair, type SviFloat } from '@/lib/svi/svi';
import type { V2Market } from '@/lib/api/v2/types';

/** Deposit-buffer headroom — matches the trade tickets' SLIPPAGE_BPS. */
const SLIPPAGE_BPS = 100;

export interface BinaryBetParams {
  market: V2Market;
  /** The market's live pricer feed. */
  forward: number;
  svi: SviFloat;
  /** Absolute strike ($); null → at-the-money (nearest admission tick to forward). */
  strikePrice: number | null;
  isUp: boolean;
  stake: number; // DUSDC
  leverage: number;
}

export interface BinaryMintPlan {
  strike: number;
  entryProb: number;
  lev: number; // clamped to the strike's admission cap
  maxLev: number;
  stakeBase: bigint;
  estCostBase: bigint;
  /** Slippage-padded ceiling — what the deposit must cover. */
  maxCost: bigint;
  /** Entry probability sits inside the quotable band (not a dead 0%/100% strike). */
  probOk: boolean;
  /** Stake clears the chain's $1 minimum net premium. */
  stakeOk: boolean;
  /** Ready for `acct.mintBudget` (add `deposit` from the caller's balance). */
  mint: {
    marketId: string;
    lowerTick: bigint;
    higherTick: bigint;
    amount: bigint;
    minQuantity: bigint;
    leverage: bigint;
  };
}

/** Build the budget-mint plan for a binary bet — mirrors compact-ticket's sizing. */
export function planBinaryBudgetMint(p: BinaryBetParams): BinaryMintPlan {
  const { market, forward, svi } = p;
  const admissionTickSize = BigInt(market.admission_tick_size);
  const atm = toFloat(snapStrikeToAdmission(fromFloat(forward), admissionTickSize));
  const strike = p.strikePrice ?? atm;

  const upProb = upFair(strike, forward, svi);
  const entryProb = p.isUp ? upProb : 1 - upProb;
  const probOk = entryProb > 0.005 && entryProb < 0.995;

  // Cap leverage by the protocol's probability-scaled admission curve (not the
  // market-wide max), exactly as the ticket does.
  const maxLev = leverageSliderMax(entryProb, toFloat(market.max_admission_leverage));
  const lev = Math.min(p.leverage, maxLev);
  const stakeBase = toQuote(Math.max(0, p.stake));
  const amount = mintAmountBase(stakeBase);
  const quantity = quantityForStake(amount, entryProb, lev);
  const minQuantity = minQuantityForBudget(quantity);
  const feeBase = BigInt(Math.round(toFloat(market.base_fee) * Number(quantity)));
  const estCostBase = stakeBase + feeBase;
  const maxCost = maxCostWithSlippage(estCostBase, SLIPPAGE_BPS);

  const { lowerTick, higherTick } = binaryTicks(
    snapStrikeToAdmission(fromFloat(strike), admissionTickSize),
    p.isUp,
    BigInt(market.tick_size),
  );

  return {
    strike,
    entryProb,
    lev,
    maxLev,
    stakeBase,
    estCostBase,
    maxCost,
    probOk,
    stakeOk: stakeBase >= MIN_STAKE_BASE,
    mint: { marketId: market.expiry_market_id, lowerTick, higherTick, amount, minQuantity, leverage: leverageScaled(lev) },
  };
}
