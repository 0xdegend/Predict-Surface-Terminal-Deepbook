/**
 * lib/sui/v2/quote.ts — pre-trade cost ESTIMATE helpers for the v2 mint flow.
 *
 * The v2 protocol has no public read-only cost view (up_price/range_price are
 * package-private), and simulating mint_exact_quantity for the authoritative
 * all-in cost needs a funded on-chain account. So the ticket estimates cost
 * client-side off the live Pricer's entry probability; the on-chain max_cost
 * guard caps it and the wallet shows the exact figure at signing.
 */

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
