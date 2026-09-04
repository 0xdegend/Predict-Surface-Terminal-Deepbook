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
  /** Net-premium budget (DUSDC base units), the same `amount` the real mint spends. */
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
  return {
    entryProb: entry / SCALE,
    premiumBase: premium,
    quantityBase: quantity,
    builderFeeBase: big(j.builder_fee) ?? 0n,
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
