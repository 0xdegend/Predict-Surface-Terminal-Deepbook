/**
 * quote-mint.ts — the chain's OWN price for a bet, read by simulating the mint.
 *
 * Every other quote in the app is client math: the pricer's forward and SVI are read
 * from chain, then `upFair` and the spread model in quote.ts turn them into a price. That
 * is right for drawing a surface and close enough for a ticket a person confirms, but it
 * is not what the protocol charges. `mint_exact_amount` sizes the position with its own
 * charge layer (spread, skew, inventory impact, and a floor on the variance of a market
 * about to settle), and the difference can be large exactly when it matters: on
 * 2026-09-04 Autopilot rated an at-the-money bet with seconds left at 70%+ by client math
 * while the chain filled it at 55.6%.
 *
 * MEASURED ON MAINNET 2026-09-26, which is why this is now the funding source for the
 * ticket too and not just for Autopilot. On a live 5m market the chain's `OrderMinted`
 * reported `trading_fee` at **9.148% of quantity** while the market's `base_fee` field
 * reads **20.4%** — so `base_fee × quantity`, which every client-side estimate in the app
 * used, is not the applied rate in either direction. The charge layer has at least seven
 * inputs (base_fee, a `min_fee` floor of 2.2%, the expiry-window ramp up to 3×,
 * inventory impact, penalty, referral, and a fee-incentive subsidy), none of them exposed
 * as a read-only view. A trader on mainnet with $2.43 in their account was refused a $1.70
 * bet because the estimate under-reserved: `account::EInsufficientBalance`, after the
 * ticket had already told them it would fit. Do not re-derive this client side.
 *
 * So for anything that fires unattended, the number that gates the bet is this one: the
 * mint is SIMULATED as the owner (no signature, no gas, about two seconds), and the
 * `OrderMinted` event the simulation emits carries the entry probability, premium, and
 * sized quantity the real transaction would land with. The real fire then goes through
 * the session key as before; this only decides whether it should.
 */
import type { Transaction } from '@mysten/sui/transactions';
import { buildMintBudgetTx } from './predict-tx';

/** The one call this needs: a simulate that can return events. `client.core` fits. */
export interface QuoteClient {
  simulateTransaction: (opts: {
    transaction: Transaction;
    include?: { events?: boolean };
    checksEnabled?: boolean;
  }) => Promise<unknown>;
}

export interface MintQuoteParams {
  owner: string;
  wrapperId: string;
  marketId: string;
  lowerTick: bigint;
  higherTick: bigint;
  /** Net-premium budget (USDC base units), the same `amount` the real mint spends. */
  amount: bigint;
  /** 1e9-scaled (1e9 = 1x). */
  leverage: bigint;
}

export interface MintQuote {
  /** The chain's entry probability for the buyer (0..1): premium per $1 of payout. */
  entryProb: number;
  /** Net premium the chain would take (base units). */
  premiumBase: bigint;
  /** Position size the chain would land on (base units). */
  quantityBase: bigint;
  /** Builder fee on top (base units). */
  builderFeeBase: bigint;
  /** Protocol trading fee (base units). NOT `base_fee × quantity`, see below. */
  tradingFeeBase: bigint;
  /** Rebate applied against the trading fee (base units). Subtracted from the total. */
  feeSubsidyBase: bigint;
  /** Pool inventory-skew charge for this trade (base units). */
  inventoryImpactBase: bigint;
  /** Late-entry penalty (base units). */
  penaltyFeeBase: bigint;
  /** Referral cut (base units). */
  referralFeeBase: bigint;
  /**
   * EVERYTHING the account must hold for this mint (base units).
   *
   * Mirrors the assertion in `expiry_market::compute_mint_quote`:
   *   premium + (trading_fee − fee_incentive_subsidy) + builder_fee
   *     + inventory_impact_charge + penalty_fee + referral_fee
   *
   * This is the number to fund against. Every term is read off the chain's own
   * simulated `OrderMinted`, so it needs no model of the protocol's charge layer.
   */
  totalCostBase: bigint;
}

const SCALE = 1e9;

/**
 * Pull the quote out of a simulate result. Shape-tolerant on purpose: the event sits at
 * `Transaction.events[i]` today, but this walks the whole result for the first
 * `::OrderMinted` event with a JSON body rather than trusting one path. Null when the
 * simulation produced no mint (aborted, or the market is not mintable).
 */
export function parseMintQuote(res: unknown): MintQuote | null {
  const ev = findOrderMinted(res);
  if (!ev) return null;
  const j = ev as Record<string, unknown>;
  const num = (v: unknown) => (v == null ? null : Number(v));
  const big = (v: unknown) => (v == null ? null : BigInt(String(v)));
  const entry = num(j.entry_probability);
  const premium = big(j.premium ?? j.net_premium);
  const quantity = big(j.quantity);
  if (entry == null || !Number.isFinite(entry) || premium == null || quantity == null) return null;
  const builderFeeBase = big(j.builder_fee) ?? 0n;
  const tradingFeeBase = big(j.trading_fee) ?? 0n;
  const feeSubsidyBase = big(j.fee_incentive_subsidy) ?? 0n;
  const inventoryImpactBase = big(j.inventory_impact_charge) ?? 0n;
  const penaltyFeeBase = big(j.penalty_fee) ?? 0n;
  const referralFeeBase = big(j.referral_fee) ?? 0n;
  // The subsidy is a rebate, never a payout: clamp so a subsidy larger than the fee
  // (which should not happen, but is a u64 on chain) can never reduce the total below
  // the premium and under-fund the account.
  const netTradingFee = tradingFeeBase > feeSubsidyBase ? tradingFeeBase - feeSubsidyBase : 0n;
  return {
    entryProb: entry / SCALE,
    premiumBase: premium,
    quantityBase: quantity,
    builderFeeBase,
    tradingFeeBase,
    feeSubsidyBase,
    inventoryImpactBase,
    penaltyFeeBase,
    referralFeeBase,
    totalCostBase:
      premium + netTradingFee + builderFeeBase + inventoryImpactBase + penaltyFeeBase + referralFeeBase,
  };
}

function findOrderMinted(v: unknown, depth = 0): unknown {
  if (depth > 8 || v == null || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const hit = findOrderMinted(x, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const r = v as Record<string, unknown>;
  if (typeof r.eventType === 'string' && r.eventType.endsWith('::OrderMinted') && r.json && typeof r.json === 'object') {
    return r.json;
  }
  for (const x of Object.values(r)) {
    const hit = findOrderMinted(x, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Simulate the budget mint as the owner and return what the chain would fill it at. */
export async function quoteBudgetMint(client: QuoteClient, p: MintQuoteParams): Promise<MintQuote | null> {
  const tx = buildMintBudgetTx({
    marketId: p.marketId,
    wrapperId: p.wrapperId,
    lowerTick: p.lowerTick,
    higherTick: p.higherTick,
    amount: p.amount,
    minQuantity: 0n,
    leverage: p.leverage,
  });
  tx.setSender(p.owner);
  const res = await client.simulateTransaction({ transaction: tx, include: { events: true }, checksEnabled: false });
  return parseMintQuote(res);
}
