/**
 * lib/sui/v2/quote.ts — pre-trade cost ESTIMATE helpers for the v2 mint flow.
 *
 * The v2 protocol has no public read-only cost view (up_price/range_price are
 * package-private), and simulating mint_exact_quantity for the authoritative
 * all-in cost needs a funded on-chain account. So the ticket estimates cost
 * client-side off the live Pricer's entry probability; the on-chain max_cost
 * guard caps it and the wallet shows the exact figure at signing.
 */
import { upFair, type SviFloat } from '@/lib/svi/svi';
import { V2_IS_729_PLUS, predictV2Config } from '@/config/predict';

/**
 * The protocol's minimum mint-time stake — `constants::min_net_premium` on
 * predict-testnet-6-24 (1_000_000 base units = $1, before fees). A mint whose
 * net premium (≈ the stake) lands under this aborts on-chain with
 * strike_exposure_config #4, so tickets must gate on it before submitting.
 */
export const MIN_STAKE_BASE = 1_000_000n;

/**
 * Order quantities must be a whole number of `constants::position_lot_size`
 * lots (10_000 base units = $0.01 of payout) — `order::assert_valid_quantity`
 * aborts any mint whose quantity isn't lot-aligned.
 */
export const POSITION_LOT_BASE = 10_000n;

/**
 * The smallest usable `mint_exact_amount` budget: $1.01. The chain sizes the
 * largest lot-rounded quantity whose net premium fits INSIDE the budget, so at
 * an exactly-$1.00 budget the lot rounding lands the premium a fraction under
 * the $1 minimum and admission aborts. One cent of headroom (> the max possible
 * per-lot premium of $0.0099) makes a minimum-size bet deterministic; the user
 * still only pays the derived premium (≤ the budget), never the pad.
 */
export const MIN_MINT_AMOUNT_BASE = 1_010_000n;

/** The mint budget for a (gate-validated, ≥$1) stake. */
export function mintAmountBase(stakeBase: bigint): bigint {
  return stakeBase < MIN_MINT_AMOUNT_BASE ? MIN_MINT_AMOUNT_BASE : stakeBase;
}

/**
 * How much a budget mint's payout may shrink from the quote before the chain
 * should reject it. A budget mint's payout floats with the live odds at
 * execution (that's what makes it robust to the $1-minimum boundary), so this
 * bounds how much worse than quoted a fill can be if the odds move against the
 * trader while they confirm. Deliberately generous — legacy had NO guard at all
 * (fixed payout, pay-what-it-costs), so we only want to catch a genuinely
 * broken fill (a violent gap), never normal short-market movement. 0.25 = the
 * trader is guaranteed at least 75% of the quoted payout, or the tx reverts.
 */
export const MAX_PAYOUT_SHRINK = 0.25;

/**
 * The `min_quantity` guard for a budget mint: the quoted payout reduced by
 * `shrink`, lot-floored. If the chain would size below this the mint aborts
 * (expiry_market #6) instead of silently buying a much smaller payout than the
 * trader was shown. Pass the same quoted quantity the ticket displays.
 */
export function minQuantityForBudget(quotedQuantity: bigint, shrink = MAX_PAYOUT_SHRINK): bigint {
  const keepBps = BigInt(Math.round((1 - shrink) * 10_000));
  return lotAlign((quotedQuantity * keepBps) / 10_000n);
}

/** Floor a raw quantity onto the lot grid (never below one lot). */
function lotAlign(quantity: bigint): bigint {
  const lots = quantity / POSITION_LOT_BASE;
  return (lots > 0n ? lots : 1n) * POSITION_LOT_BASE;
}

/** Quantity (base units) for a target max-payout in whole DUSDC. 1 → 1_000_000. */
export function quantityForPayout(payoutDusdc: number): bigint {
  return lotAlign(BigInt(Math.round(payoutDusdc * 1_000_000)));
}

/**
 * Quantity (max-payout base units) sized so the trader pays ~`stakeBase` upfront.
 * Cost at 1x ≈ entry_probability × quantity, and leverage L cuts the upfront to
 * ≈ cost/L — so to spend `stake` you can control L× the position:
 *   quantity = stake × L / entry_probability
 * Floored onto the lot grid (the chain rejects non-lot quantities). An estimate
 * (no public cost view); the on-chain max_cost guard enforces it.
 */
export function quantityForStake(stakeBase: bigint, entryProb: number, leverage: number): bigint {
  const p = Math.min(Math.max(entryProb, 1e-6), 1);
  return lotAlign(BigInt(Math.round((Number(stakeBase) * Math.max(1, leverage)) / p)));
}

/**
 * What a WINNING position actually PAYS OUT (DUSDC base units) — the max-payout
 * `quantity` minus the static leverage floor `entry_value·(1 − 1/L)` (with
 * `entry_value = entryProb·quantity`). Unleveraged (L ≤ 1) ⇒ the full quantity.
 *
 * A leveraged win never pays the full max payout: you only staked `1/L` of the
 * entry value and the other `(1 − 1/L)` is the floor that's netted out on
 * redeem. Mirrors the on-chain settled payout (verified: quantity $12.72, entry
 * 78.6%, 2× → floor $5.00 → $7.72, NOT $12.72), and matches `leverageFloor` on
 * the portfolio side. Use this for every "you win" / max-win figure so the
 * ticket preview equals what actually lands.
 */
export function winPayout(quantityBase: bigint, entryProb: number, leverage: number): bigint {
  if (leverage <= 1) return quantityBase;
  const q = Number(quantityBase);
  const floor = Math.min(Math.max(entryProb, 0), 1) * q * (1 - 1 / leverage);
  const win = Math.round(q - floor);
  return win > 0 ? BigInt(win) : 0n;
}

/**
 * The protocol's admission curve constant `k` — `config_constants::
 * admission_leverage_curve_k = 200_000_000` (0.2, 1e9-scaled) on
 * predict-testnet-6-24. Do not confuse with `liquidation_ltv`.
 */
export const ADMISSION_LEVERAGE_CURVE_K = 0.2;

/**
 * The largest leverage the protocol will ADMIT at a given entry probability —
 * `strike_exposure_config::admitted_leverage_cap`, source-verified
 * (predict-testnet-6-24):
 *   risk_curve = p·(1 + k)/(p + k)              // 0 at p=0, →1 as p→1
 *   cap        = 1 + (maxAdmissionLeverage − 1)·risk_curve
 * The market's `max_admission_leverage` (e.g. 3×) is only the p→1 asymptote — the
 * curve scales it DOWN for anything short of a near-certainty, so the achievable
 * cap is strictly below it at every tradeable strike (e.g. 2.71× at 50/50, 2.997×
 * at 99% with maxLev=3, k=0.2). This is the check that aborts a mint with
 * `ELeverageAboveAdmissionCap` (strike_exposure_config #6). `entryProb` is the
 * direction-fair chance of the side being bet.
 */
export function admittedLeverageCap(
  entryProb: number,
  maxAdmissionLeverage: number,
  k = ADMISSION_LEVERAGE_CURVE_K,
): number {
  const p = Math.min(Math.max(entryProb, 0), 1);
  const lMax = Math.max(1, maxAdmissionLeverage);
  if (p <= 0) return 1;
  const riskCurve = (p * (1 + k)) / (p + k);
  return 1 + (lMax - 1) * riskCurve;
}

/**
 * 7-29's admission cap (verified live against the chain). Two changes from 6-24:
 *  1. Leverage is gated by CONFIDENCE — how far the odds sit from 50/50, i.e.
 *     |2p − 1| — not raw probability. The chain admits the MOST leverage on
 *     near-certain strikes (either direction) and the LEAST at a coin-flip, where
 *     a leveraged position is likeliest to be knocked out. (6-24 did the opposite,
 *     scaling up with raw p, which over-offered at 50/50 and aborted every mint.)
 *  2. Within `no_leverage_window_ms` of expiry, leverage is disabled (1x). Every
 *     short testnet market sits inside the 60-min window, so leverage there is 1x.
 * `msToExpiry` is the market's time to expiry; `null` skips the window gate.
 */
export function admittedLeverageCap729(
  entryProb: number,
  maxAdmissionLeverage: number,
  msToExpiry: number | null = null,
): number {
  const window = predictV2Config.noLeverageWindowMs;
  if (window > 0 && msToExpiry != null && msToExpiry <= window) return 1;
  const p = Math.min(Math.max(entryProb, 0), 1);
  const confidence = Math.abs(2 * p - 1);
  return 1 + (Math.max(1, maxAdmissionLeverage) - 1) * confidence;
}

/** The admission cap for the ACTIVE deployment: 7-29 = confidence curve + the
 *  no-leverage window; 6-24 = the probability-only curve. */
export function effectiveLeverageCap(
  entryProb: number,
  maxAdmissionLeverage: number,
  msToExpiry: number | null = null,
): number {
  return V2_IS_729_PLUS
    ? admittedLeverageCap729(entryProb, maxAdmissionLeverage, msToExpiry)
    : admittedLeverageCap(entryProb, maxAdmissionLeverage);
}

/**
 * The largest WHOLE-number leverage a trader may select at these odds — the
 * admitted cap floored to an integer preset, never below 1×. A hair of margin
 * (1e-6) keeps us safely under the chain's fixed-point `mul_div_down` cap at the
 * exact integer boundary. Use this to size leverage presets so the UI never
 * offers a multiple the chain will reject (the market-wide `max_admission_leverage`
 * over-promises — a full 3× is unreachable below 100% odds).
 */
export function maxSelectableLeverage(
  entryProb: number,
  maxAdmissionLeverage: number,
  msToExpiry: number | null = null,
): number {
  return Math.max(1, Math.floor(effectiveLeverageCap(entryProb, maxAdmissionLeverage, msToExpiry) - 1e-6));
}

/** Granularity of the continuous leverage slider — 0.1× steps. */
export const LEVERAGE_STEP = 0.1;

/**
 * The max leverage a CONTINUOUS slider should allow at these odds: the admitted
 * cap floored onto the 0.1× grid (a hair under the exact cap via the 1e-6 nudge,
 * so we stay inside the chain's fixed-point bound). ≥ 1×. Unlike
 * `maxSelectableLeverage` (whole-number presets) this exposes the fractional
 * headroom — e.g. 2.7× at 50/50 instead of stopping at 2×. The pre-flight
 * simulate ([[enoki-sponsor]]) backstops any odds drift between quote and mint.
 */
export function leverageSliderMax(
  entryProb: number,
  maxAdmissionLeverage: number,
  msToExpiry: number | null = null,
): number {
  const cap = effectiveLeverageCap(entryProb, maxAdmissionLeverage, msToExpiry) - 1e-6;
  return Math.max(1, Math.floor(cap / LEVERAGE_STEP) * LEVERAGE_STEP);
}

/**
 * The knockout barrier for a leveraged binary — the direction-fair chance at
 * which the position is closed early. Source-verified (predict-testnet-6-24):
 * at mint the static floor is `F = entryProb·qty·(1 − 1/L)`, and
 * `liquidate_order_if_under_floor` closes when `qty·P_live ≤ F/ltv`, i.e. when
 * the live chance `P_live` falls to `entryProb·(1 − 1/L)/ltv`. A liquidated
 * order pays $0. At L = 1 the floor is 0, so there is no barrier (returns null).
 */
export function knockoutProbability(entryProb: number, leverage: number, liquidationLtv: number): number | null {
  if (leverage <= 1 || liquidationLtv <= 0) return null;
  const p = entryProb * (1 - 1 / leverage) / liquidationLtv;
  return p > 0 && p < entryProb ? p : null;
}

/**
 * The adverse price move — as a fraction of the current forward — that would
 * drop a leveraged position's live win-chance to its knockout barrier: i.e. how
 * far the underlying can move AGAINST you before you're knocked out and lose
 * your whole stake. This is the risk number leverage actually changes (the loss
 * AMOUNT is always the full stake at any leverage; the barrier just gets closer).
 *
 * For an UP bet the price must FALL to push the fair below the barrier; for DOWN
 * it must RISE. We hold the SVI (moneyness) surface fixed and solve for the
 * forward at which the direction-fair equals the barrier — the standard
 * sticky-moneyness estimate, matching how the rest of the ticket prices
 * client-side. Returns the positive move fraction (0.042 = a 4.2% move), or null
 * when there's no leverage barrier (L ≤ 1) or the solve is degenerate.
 */
export function priceMoveToKnockout(
  strike: number,
  forward: number,
  svi: SviFloat,
  isUp: boolean,
  leverage: number,
  liquidationLtv: number,
): number | null {
  if (forward <= 0) return null;
  const entryUp = upFair(strike, forward, svi);
  const entryProb = isUp ? entryUp : 1 - entryUp;
  if (!(entryProb > 0) || entryProb >= 1) return null;
  const koProb = knockoutProbability(entryProb, leverage, liquidationLtv);
  if (koProb == null) return null;

  // Direction-fair as the forward moves. UP fair increases with the forward;
  // DOWN fair (1 − UP) decreases with it. Both are monotone → bisection.
  const dirFairAt = (f: number) => {
    const up = upFair(strike, f, svi);
    return isUp ? up : 1 - up;
  };
  // Search away from the current forward in the adverse direction, over a wide
  // bracket; bail if the barrier isn't reached inside it (practically un-knockable).
  let lo: number;
  let hi: number;
  if (isUp) {
    lo = forward * 0.2; // deep adverse (price crashed) → fair ≈ 0
    hi = forward; //       current → fair = entryProb
    if (dirFairAt(lo) > koProb) return null;
  } else {
    lo = forward; //       current → fair = entryProb
    hi = forward * 1.8; // deep adverse (price ripped) → fair ≈ 0
    if (dirFairAt(hi) > koProb) return null;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const f = dirFairAt(mid);
    // UP: dirFair rises with the forward. DOWN: it falls. Move the bound that
    // keeps `koProb` bracketed either way.
    if (isUp ? f > koProb : f <= koProb) hi = mid;
    else lo = mid;
  }
  const fKo = (lo + hi) / 2;
  const move = Math.abs(forward - fKo) / forward;
  return move > 0 && move < 1 ? move : null;
}
