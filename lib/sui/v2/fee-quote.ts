/**
 * fee-quote.ts — the protocol's OWN cost arithmetic, from `@mysten/deepbook-v3`.
 *
 * Every ticket in this app used to price a bet as `stake + base_fee × quantity`. That was
 * wrong by construction, and the docstring on the SDK's `FeePolicy` is why:
 *
 *     base_fee — multiplies sqrt(p·(1−p))
 *
 * The trading fee is a BERNOULLI (variance) fee, not a flat rate. It peaks at
 * `base_fee × 0.5` when the odds are even and falls away toward either extreme. With the
 * live mainnet `base_fee` of 20.4% the real rate therefore tops out at 10.2% of payout, so
 * our flat 20.4% overstated the fee by AT LEAST 2x at every probability, and by more the
 * further from even the odds were. Measured against live mainnet mints on 2026-09-27:
 * at p=0.7329 the formula gives 9.03% and the chain charged 9.026%; at p=0.2587 it gives
 * 8.93% and the chain charged 8.934%.
 *
 * `@mysten/deepbook-v3` 2.6.0 (2026-09-18, ts-sdks#1278) ships that arithmetic as an exact
 * integer port of the deployed fee path, including the per-boundary legs, the `min_fee`
 * floor, the expiry ramp, the builder cut, the sponsor subsidy, the congestion surcharge
 * and inventory impact. This module is the thin adapter from our `V2Market` onto it.
 *
 * SCOPE, and it matters: this is ARITHMETIC, NOT A PREFLIGHT. Mysten say so explicitly and
 * they are right. It cannot see the account's balance, ownership, market gates, oracle
 * freshness or pool cash. It is for what we SHOW. What we FUND stays on the chain simulate
 * in `quote-mint.ts`, which is the only thing that can refuse a trade honestly.
 */
import { cost as dbCost } from '@mysten/deepbook-v3/predict';
import type { V2Market } from '@/lib/api/v2/types';

/** The fields of a market that determine what a bet costs. */
export type FeeMarket = Pick<
  V2Market,
  | 'base_fee'
  | 'min_fee'
  | 'expiry_fee_window_ms'
  | 'expiry_fee_max_multiplier'
  | 'min_entry_probability'
  | 'max_entry_probability'
  | 'max_expiry_allocation'
  | 'backing_buffer_lambda'
  | 'expiry'
> & { inventory_impact_max_rate?: string };

const big = (v: string | number | undefined, fallback = 0n): bigint => {
  if (v === undefined || v === null || v === '') return fallback;
  try {
    return typeof v === 'number' ? BigInt(Math.round(v)) : BigInt(v);
  } catch {
    return fallback;
  }
};

/**
 * Map one of our markets onto the SDK's `FeePolicy`.
 *
 * Read PER MARKET, never from the template: the config is snapshotted into a market at
 * creation, so an admin change does not reprice a market already trading, and two live
 * markets can legitimately charge differently.
 *
 * `backing_buffer_lambda` is typed `number` on our side but is ALREADY the raw 1e9 integer
 * (the live mainnet markets carry 310000000, i.e. 0.31), so it is converted and never
 * rescaled. Scaling it cost a round here: the SDK validates the range and threw
 * `backingBufferLambda must be an integer in [0, 1000000000]`.
 * `inventory_impact_max_rate` is optional on ours (absent before 9-12) and `0n` correctly
 * means "impact disabled", which is the shipped value on mainnet today.
 */
export function feePolicyFor(market: FeeMarket): dbCost.FeePolicy {
  return {
    baseFee: big(market.base_fee),
    minFee: big(market.min_fee),
    expiryFeeWindowMs: big(market.expiry_fee_window_ms),
    expiryFeeMaxMultiplier: big(market.expiry_fee_max_multiplier, 1_000_000_000n),
    minEntryProbability: big(market.min_entry_probability),
    maxEntryProbability: big(market.max_entry_probability, 1_000_000_000n),
    inventoryImpactMaxRate: big(market.inventory_impact_max_rate),
    inventoryImpactScale: big(market.max_expiry_allocation),
    backingBufferLambda: big(market.backing_buffer_lambda),
  };
}

/** What the ticket needs back: the all-in debit and the honest payout multiple. */
export interface LocalMintCost {
  /** Maximum payout bought (human USD). */
  quantity: number;
  /** Fill price per $1 of payout, before fees. */
  entryProbability: number;
  /** Premium into LP backing (human USD). */
  premium: number;
  /** The protocol's trading fee NET of any sponsor subsidy (human USD). */
  protocolFee: number;
  /** The builder fee, ours (human USD). */
  builderFee: number;
  /** Congestion surcharge + inventory impact (human USD). Zero on the shipped config. */
  otherFees: number;
  /** All-in account debit (human USD). */
  cost: number;
  /** Max payout divided by the all-in debit. The number the ticket shows as `1.25x`. */
  payoutMultiple: number;
  raw: { quantity: bigint; cost: bigint; tradingFee: bigint; builderFee: bigint };
}

/** Normalize either SDK result shape into the one thing our surfaces render. */
function toLocal(q: dbCost.MintCost): LocalMintCost {
  return {
    quantity: q.quantity,
    entryProbability: q.entryProbability,
    premium: q.premium,
    protocolFee: q.fees.trading - q.fees.subsidy,
    builderFee: q.fees.builder,
    otherFees: q.fees.penalty + q.fees.impact,
    cost: q.cost,
    payoutMultiple: q.payoutMultiple,
    raw: {
      quantity: q.raw.quantity,
      cost: q.raw.cost,
      tradingFee: q.raw.tradingFee,
      builderFee: q.raw.builderFee,
    },
  };
}

export interface LocalQuoteParams {
  market: FeeMarket;
  /** Boundary UP probabilities, raw 1e9. `null` is an infinite side. */
  lowerUp: bigint | null;
  higherUp: bigint | null;
  /** True when the minting account carries our builder code, so the builder fee applies. */
  builderCode: boolean;
  /** The expiry's remaining sponsored fee balance, if known. */
  feeIncentiveBalance?: bigint;
  nowMs?: number;
}

/**
 * All-in cost for a BUDGET mint — the shape every ticket in this app uses (the trader picks
 * a stake, the chain sizes the payout). Returns `null` rather than throwing: the SDK raises
 * `PredictInputError` for exactly the admission checks the chain would abort on, and on a
 * display path an unpriceable bet must degrade to "no quote", never to a crash mid-render.
 */
export function localBudgetCost(p: LocalQuoteParams & { budgetBase: bigint }): LocalMintCost | null {
  try {
    return toLocal(
      dbCost.mintCostForBudget({
        fees: feePolicyFor(p.market),
        expiryMs: p.market.expiry,
        nowMs: p.nowMs ?? Date.now(),
        probabilities: { lowerUp: p.lowerUp, higherUp: p.higherUp },
        builderCode: p.builderCode,
        feeIncentiveBalance: p.feeIncentiveBalance ?? 0n,
        budget: p.budgetBase,
      }),
    );
  } catch {
    return null;
  }
}

/** All-in cost for an EXACT payout quantity. Same contract as `localBudgetCost`. */
export function localQuantityCost(p: LocalQuoteParams & { quantityBase: bigint }): LocalMintCost | null {
  try {
    return toLocal(
      dbCost.mintCost({
        fees: feePolicyFor(p.market),
        expiryMs: p.market.expiry,
        nowMs: p.nowMs ?? Date.now(),
        probabilities: { lowerUp: p.lowerUp, higherUp: p.higherUp },
        builderCode: p.builderCode,
        feeIncentiveBalance: p.feeIncentiveBalance ?? 0n,
        quantity: p.quantityBase,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * The all-in cost of a BINARY bet, the shape simple mode and the compact ticket use.
 *
 * A binary UP is the range [strike, +inf) and a binary DOWN is (-inf, strike]: one finite
 * leg and one infinite one, and the infinite side pays no fee leg. Callers hold `upProb`
 * (the probability the market settles ABOVE the line) and `isUp`, which is exactly the pair
 * the boundary form wants, so nothing has to be inverted at the call site.
 *
 * Returns `null` when the bet is unpriceable, for the caller to fall back on.
 */
export function binaryCost(p: {
  market: FeeMarket;
  /** P(settle > line), 0..1. NOT the entry probability of a DOWN bet. */
  upProb: number;
  isUp: boolean;
  quantityBase: bigint;
  builderCode: boolean;
  nowMs?: number;
}): LocalMintCost | null {
  const raw = BigInt(Math.round(Math.min(1, Math.max(0, p.upProb)) * 1e9));
  return localQuantityCost({
    market: p.market,
    lowerUp: p.isUp ? raw : null,
    higherUp: p.isUp ? null : raw,
    builderCode: p.builderCode,
    quantityBase: p.quantityBase,
    nowMs: p.nowMs,
  });
}
