/**
 * lib/sui/v2/mint-policy.ts — the odds band the protocol will actually mint.
 *
 * `strike_exposure_config::assert_mint_probability_policy` rejects any mint whose entry
 * probability sits outside [min_entry_probability, max_entry_probability]. Every quoting
 * surface has to gate on the SAME band, because a bet outside it is not a bad price, it is
 * a transaction the chain refuses.
 *
 * WHY THIS MODULE EXISTS. The band used to be the literal `> 0.005 && < 0.995`, copied
 * across seven call sites. The chain enforces 1% to 99%, so those literals opened two dead
 * zones (0.5% to 1%, and 99% to 99.5%) where the app quoted a bet happily, let the trader
 * fund it, and the WALLET was the first thing to say no: on 2026-09-17 a $130.72 bet on
 * 9-12 reached the signature prompt and dry-ran as `MoveAbort ... assert_mint_probability_
 * policy`. A trader reads that as the app being broken, and they are not wrong.
 *
 * The band is per market (`min_entry_probability` / `max_entry_probability` on the market
 * object, carried on the `MarketCreated` event), so it is read from the market rather than
 * assumed. FALLBACK_BAND is only for a caller with no market in hand, and it is the live
 * 9-12 protocol template, verified on chain 2026-09-17 by calling
 * `protocol_config::strike_exposure_template_config` and reading both getters off it.
 *
 * NOTE for the next deployment: 9-12 moved these values OFF `expiry_market` (the getters no
 * longer exist there) and onto `strike_exposure_config`, reachable via the protocol config.
 * `onchainMarketState` therefore cannot read them and fills both fields from its hardcoded
 * TEMPLATE, which happens to match today. If a redeploy widens or narrows the band, the
 * markets built by that path will still claim the old one. Re-verify at every cutover.
 */
import { toFloat } from '@/config/scale';

/** The band a market carries. Both values are 1e9-scaled probabilities on chain. */
export interface ProbabilityBand {
  /** Lowest mintable entry probability, as a fraction (0.01 = 1%). */
  min: number;
  /** Highest mintable entry probability, as a fraction (0.99 = 99%). */
  max: number;
}

/** The 9-12 protocol template, used only when no market is available. */
export const FALLBACK_BAND: ProbabilityBand = { min: 0.01, max: 0.99 };

type BandSource =
  | {
      min_entry_probability?: string | number;
      max_entry_probability?: string | number;
      /** Trading fee as a fraction of quantity (1e9-scaled on chain). Template: 2%. */
      base_fee?: string | number;
      /** `expiry_market::inventory_impact_max_rate`, new on 9-12. Absent ⇒ fallback below. */
      inventory_impact_max_rate?: string | number;
    }
  | undefined;

/**
 * THE SECOND, TIGHTER CEILING: cost must not exceed the payout.
 *
 * `expiry_market::compute_mint_quote` asserts (verified by disassembling the live 9-12
 * module, 2026-09-24):
 *
 *     premium + (trading_fee − fee_incentive_subsidy) + builder_fee + inventory_impact_charge
 *       ≤ quantity            else abort 11
 *
 * `quantity` is the MAX PAYOUT, and premium ≈ entry_probability × quantity, so the fees
 * only fit while `entry_probability ≤ 1 − (fee rates)`. With the 9-12 template that is
 * roughly 97.8% BEFORE any inventory charge — well under the 99% the market advertises as
 * `max_entry_probability`. Betting between the two is not a bad price, it is a transaction
 * the chain refuses, which is exactly the dead zone this module exists to close.
 *
 * Builder fee is `min(10% of trading_fee, 0.5% of quantity)` — read off the same bytecode
 * (`builder_fee_amount`: `mul_down(fee, 100_000_000)` vs `mul_down(quantity, 5_000_000)`).
 *
 * The inventory charge is per-trade and depends on pool inventory we cannot see, so we
 * reserve the market's own `inventory_impact_max_rate` when it is present and a modest
 * constant when it is not. Reserving too much only declines a bet the chain might have
 * taken; reserving too little quotes one it will certainly reject.
 */
const BUILDER_FEE_SHARE_OF_TRADING_FEE = 0.1;
const BUILDER_FEE_CAP_RATE = 0.005;
/** Template `base_fee` (2%), used when a caller has no market in hand. */
const FALLBACK_BASE_FEE = 0.02;
/** Reserved for `inventory_impact_charge` when the market's max rate is unknown. */
export const INVENTORY_IMPACT_FALLBACK_RATE = 0.005;

const num = (v: string | number | undefined): number | null => {
  if (v == null) return null;
  const n = toFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * The highest entry probability whose all-in cost still fits inside the payout.
 * Always ≤ 1; callers take the lower of this and the market's declared max.
 */
export function costCeilingProbability(market?: BandSource): number {
  const baseFee = num(market?.base_fee) ?? FALLBACK_BASE_FEE;
  const builderFee = Math.min(BUILDER_FEE_SHARE_OF_TRADING_FEE * baseFee, BUILDER_FEE_CAP_RATE);
  const inventory = num(market?.inventory_impact_max_rate) ?? INVENTORY_IMPACT_FALLBACK_RATE;
  return 1 - baseFee - builderFee - inventory;
}

/**
 * The band this market will mint in. A market missing either bound falls back rather than
 * widening: quoting a bet the chain refuses is worse than declining one it would have taken.
 */
export function mintProbabilityBand(market?: BandSource): ProbabilityBand {
  const min = market?.min_entry_probability != null ? toFloat(market.min_entry_probability) : NaN;
  const max = market?.max_entry_probability != null ? toFloat(market.max_entry_probability) : NaN;
  return {
    min: Number.isFinite(min) && min > 0 ? min : FALLBACK_BAND.min,
    max: Number.isFinite(max) && max > 0 ? max : FALLBACK_BAND.max,
  };
}

/**
 * The band a bet must ACTUALLY land in — the market's declared bounds intersected with the
 * cost ceiling. The chain enforces the two independently, in different modules, so a bet
 * has to satisfy both:
 *
 *   `strike_exposure_config::assert_mint_probability_policy` → the declared band
 *   `expiry_market::compute_mint_quote`                      → cost ≤ payout, else abort 11
 *
 * Use this for anything user-facing (a slider bound, a quotable check). `mintProbabilityBand`
 * stays the DECLARED band so each function keeps mapping to exactly one on-chain rule, which
 * is what makes them cheap to re-verify at a cutover.
 */
export function effectiveMintBand(market?: BandSource): ProbabilityBand {
  const declared = mintProbabilityBand(market);
  return { min: declared.min, max: Math.min(declared.max, costCeilingProbability(market)) };
}

/**
 * Whether a mint at these odds would be admitted. Exclusive at both ends: the chain asserts
 * a strict comparison, so a probability exactly on the bound is not mintable.
 */
export function probabilityMintable(entryProb: number, market?: BandSource): boolean {
  const { min, max } = effectiveMintBand(market);
  return entryProb > min && entryProb < max;
}
