/**
 * lib/markets/v2-fees.ts — what a bet actually costs, and what it actually pays.
 *
 * THE BUG THIS EXISTS TO FIX. Every payout, edge and EV on the Options page was
 * GROSS. The ladder printed "5.56×", the payoff panel printed "+$456", and the edge
 * scanner ranked strikes by an edge with no fee subtracted — while the only place on
 * the whole page that touched `base_fee` was the strategy builder, a Pro tool buried
 * in a tab. So the page's headline numbers disagreed with the numbers the mint path
 * charges, and the disagreement was largest exactly where a trader is most tempted.
 *
 * THE SHAPE OF THE FEE is what makes this matter more than a rounding note. The
 * protocol trade fee is charged on NOTIONAL (the max payout), not on the stake:
 *
 *     quantity  = stake / p            (notional; what a winner collects at 1×)
 *     tradeFee  = notionalRate × quantity
 *     skewFee   = stakeRate × stake    (our own router, charged on the premium)
 *     committed = stake × (1 + stakeRate + notionalRate / p)
 *
 * Because notional scales as 1/p, the fee grows as the bet gets longer-odds. On the
 * live config (base_fee 2%) an even-money bet loses ~4% of its return to fees, while
 * an 18% longshot loses ~10% of its return — 5.56× gross becomes 4.98× net. A page
 * that quotes gross flatters the longshots most, which is precisely backwards.
 *
 * TWO RESULTS FALL OUT, both clean, and both used everywhere on the page:
 *
 *     netPayout(p)   = 1 / D          where D = p·(1 + stakeRate) + notionalRate
 *     breakeven(p)   = D
 *
 * The second one is the important one. A bet is +EV only when the TRUE probability
 * clears D, so the edge a trader needs before a trade is worth taking is
 * `(D − p) × 100` points, which on the live config is ~2.0 to 2.4 points at every
 * strike. The edge scanner's default `minEdgePts` was 2 — i.e. it was floating
 * break-even trades to the top of the board and labelling them value. That is not a
 * cosmetic omission, it is a screener pointed at zero.
 *
 * WHAT IS NOT MODELLED HERE, deliberately: leverage (the Options page quotes
 * everything at 1×, and leverage is not shipping to mainnet), the early-close
 * penalty, and the protocol's expiry fee ramp (`expiry_fee_window_ms` /
 * `expiry_fee_max_multiplier`, currently off on the live config — when it is switched
 * on, `notionalRateFor` is the one place that needs to learn about it).
 *
 * Mirrors `planBinaryBudgetMint` in lib/sui/v2/budget-mint (`base_fee × quantity`)
 * and `skewFeeBase` in lib/sui/v2/skew-fee (`fee_bps × stake / 10_000`), so the
 * quoted number and the charged number come from one definition.
 *
 * Pure + side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */
import { toFloat } from '@/config/scale';
import type { V2Market } from '@/lib/api/v2/types';

export interface FeeRates {
  /** Protocol trade fee as a fraction of NOTIONAL (max payout). From `base_fee`. */
  notional: number;
  /** Skew's fee as a fraction of STAKE. 0 when the router is not published. */
  stake: number;
}

/** No fees at all — the honest default before a market or a rate has loaded. */
export const NO_FEES: FeeRates = { notional: 0, stake: 0 };

/**
 * The rates in force for a market. `skewFeeBps` comes from the on-chain FeeConfig
 * (useSkewFeeV2); pass 0 or omit it on the paths where our router does not charge
 * (session-key trades are fee-free).
 */
export function feeRatesFor(market: Pick<V2Market, 'base_fee'> | null | undefined, skewFeeBps = 0): FeeRates {
  return {
    notional: market ? Math.max(0, toFloat(market.base_fee)) : 0,
    stake: Math.max(0, skewFeeBps) / 10_000,
  };
}

/**
 * D — the denominator every other result here is built from, and the break-even true
 * probability in its own right. Dollars committed per dollar of notional bought.
 */
function denom(prob: number, rates: FeeRates): number {
  return prob * (1 + rates.stake) + rates.notional;
}

/** Gross payout multiple: what $1 of STAKE returns, ignoring fees. `1 / p`. */
export function grossPayoutMultiple(prob: number): number {
  return prob > 0 ? 1 / prob : 0;
}

/**
 * Net payout multiple: what $1 COMMITTED returns if the bet wins, after the trade fee
 * and our own fee. This is the number a trader can check against their wallet.
 */
export function netPayoutMultiple(prob: number, rates: FeeRates): number {
  const d = denom(prob, rates);
  return d > 0 ? 1 / d : 0;
}

/**
 * The true probability a bet must clear to be worth taking. Below this the trade
 * loses money in expectation no matter how good the "edge" looks.
 */
export function breakevenProb(prob: number, rates: FeeRates): number {
  return denom(prob, rates);
}

/**
 * How many probability POINTS of edge the fees eat, at this strike. The floor any
 * edge must clear before it is an edge at all.
 */
export function breakevenEdgePts(prob: number, rates: FeeRates): number {
  return (denom(prob, rates) - prob) * 100;
}

/**
 * Edge after fees, in probability points: how far the realized rate clears the price
 * INCLUDING what it costs to trade it. This is `edgePts − breakevenEdgePts`, i.e. the
 * gross edge with the fee floor subtracted, and it is the number that should decide
 * whether a row belongs on a screener at all.
 */
export function netEdgePts(empirical: number, implied: number, rates: FeeRates): number {
  return (empirical - denom(implied, rates)) * 100;
}

/**
 * Expected value per dollar committed, as a percentage, after fees. Positive means
 * the recent base rate beats what the bet costs to hold.
 */
export function netEvPct(empirical: number, implied: number, rates: FeeRates): number {
  const d = denom(implied, rates);
  return d > 0 ? (empirical / d - 1) * 100 : 0;
}

/** Total fee in dollars for a `stake`-dollar bet at `prob`, at 1×. */
export function feeOnStake(stake: number, prob: number, rates: FeeRates): number {
  if (!(stake > 0) || !(prob > 0)) return 0;
  return stake * (rates.stake + rates.notional / prob);
}

/** True when either rate is actually charging something (so copy can stay quiet). */
export function hasFees(rates: FeeRates): boolean {
  return rates.notional > 0 || rates.stake > 0;
}
