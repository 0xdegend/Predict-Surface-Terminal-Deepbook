/**
 * lib/sui/v2/quote.ts — pre-trade cost ESTIMATE for the v2 mint flow.
 *
 * The v2 protocol has no public read-only cost view (up_price/range_price are
 * package-private), and simulating mint_exact_quantity for the authoritative
 * all-in cost needs a funded on-chain account. So before funding we estimate:
 *
 *   premium(1x) = entry_probability × quantity      (the digital's fair cost)
 *   fee         ≈ base_fee_rate × quantity           (base_fee read as a 1e9 rate)
 *   est_cost    = premium + fee                       (at 1x; leverage only lowers it)
 *
 * `maxCost` (the on-chain slippage guard) is est_cost × (1 + slippage). Because
 * leverage REDUCES the upfront cost, a max_cost derived from the 1x estimate is a
 * safe upper bound at any leverage ≥ 1 — the chain charges the exact amount and
 * rejects only if it would exceed this cap. Treat the displayed cost as an
 * estimate; the wallet shows the exact figure at signing.
 */
import { toFloat } from '@/config/scale';
import { maxCostWithSlippage } from './ticks';

export interface MintEstimateInput {
  /** Fair entry probability as a fraction 0..1 (fairUp / fairDn from the Pricer). */
  entryProb: number;
  /** Max payout in DUSDC base units (1e6 = $1). */
  quantityBase: bigint;
  /** Market base_fee (1e9-scaled rate, e.g. "20000000" = 2%). */
  baseFee1e9: string | number | bigint;
  /** Slippage tolerance in basis points for the max_cost cap. */
  slippageBps: number;
}

export interface MintEstimate {
  entryProb: number;
  quantityBase: bigint;
  premiumBase: bigint; // entry_probability × quantity (1x)
  feeBase: bigint; // estimated fee
  estCostBase: bigint; // premium + fee (1x)
  maxCostBase: bigint; // slippage-padded cap (safe for any leverage ≥ 1)
}

export function estimateMint(p: MintEstimateInput): MintEstimate {
  const prob = Math.min(Math.max(p.entryProb, 0), 1);
  const qty = p.quantityBase;
  const premiumBase = BigInt(Math.round(prob * Number(qty)));
  const feeRate = toFloat(p.baseFee1e9); // 1e9 → fraction
  const feeBase = BigInt(Math.round(feeRate * Number(qty)));
  const estCostBase = premiumBase + feeBase;
  return {
    entryProb: prob,
    quantityBase: qty,
    premiumBase,
    feeBase,
    estCostBase,
    maxCostBase: maxCostWithSlippage(estCostBase, p.slippageBps),
  };
}

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
