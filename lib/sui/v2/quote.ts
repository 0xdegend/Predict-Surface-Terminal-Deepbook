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

/** Quantity (base units) for a target max-payout in whole DUSDC. 1 → 1_000_000. */
export function quantityForPayout(payoutDusdc: number): bigint {
  return BigInt(Math.round(payoutDusdc * 1_000_000));
}

/**
 * Quantity (max-payout base units) sized so the trader pays ~`stakeBase` upfront.
 * Cost at 1x ≈ entry_probability × quantity, and leverage L cuts the upfront to
 * ≈ cost/L — so to spend `stake` you can control L× the position:
 *   quantity = stake × L / entry_probability
 * An estimate (no public cost view); the on-chain max_cost guard enforces it.
 */
export function quantityForStake(stakeBase: bigint, entryProb: number, leverage: number): bigint {
  const p = Math.min(Math.max(entryProb, 1e-6), 1);
  return BigInt(Math.round((Number(stakeBase) * Math.max(1, leverage)) / p));
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
