/**
 * lib/sui/quote.ts — chain-authoritative trade quotes via simulateTransaction.
 *
 * §6.1 hard rule: the price a user pays/receives ALWAYS comes from the chain
 * (get_trade_amounts / get_range_trade_amounts), never from client SVI math. The
 * contract applies a utilization+inventory spread we deliberately don't replicate.
 *
 * gRPC's simulateTransaction is the devInspect equivalent. We call the read-only
 * `get_trade_amounts` (a public, non-entry fn returning (mint_cost, redeem_payout))
 * with `checksEnabled: false`, then BCS-decode the two u64 return values.
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictConfig } from '@/config/predict';
import { buildMarketKey, buildRangeKey } from '@/lib/keys';

/**
 * Minimal shape of the client we need (pass `useCurrentClient().core`).
 * Return is `unknown` because the SDK's concrete result type is generic on the
 * include flags; we structurally narrow it in `decodeTwoU64`.
 */
export interface SimulateCapableClient {
  simulateTransaction: (opts: {
    transaction: Transaction;
    include?: { commandResults?: boolean };
    checksEnabled?: boolean;
  }) => Promise<unknown>;
}

interface CommandOutput {
  bcs: Uint8Array;
}
interface CommandResult {
  returnValues: CommandOutput[];
}
interface SimulateResult {
  $kind: string;
  commandResults?: CommandResult[];
  FailedTransaction?: { status?: { error?: unknown } };
}

/** Both legs of a quote, in DUSDC base units (6 dec). */
export interface TradeQuote {
  mintCost: bigint; // pay this to mint `quantity`
  redeemPayout: bigint; // receive this to redeem `quantity` now
}

function decodeTwoU64(raw: unknown): TradeQuote {
  const res = raw as SimulateResult;
  if (res.$kind === 'FailedTransaction') {
    const err = res.FailedTransaction?.status?.error;
    const msg =
      typeof err === 'string' ? err : (err as { message?: string })?.message ?? 'simulate failed';
    throw new Error(`quote simulate failed: ${msg}`);
  }
  const cmds = res.commandResults ?? [];
  const last = cmds[cmds.length - 1];
  if (!last || last.returnValues.length < 2) {
    throw new Error('quote simulate returned no values (is the function read-only + public?)');
  }
  const cost = BigInt(bcs.u64().parse(last.returnValues[0].bcs));
  const payout = BigInt(bcs.u64().parse(last.returnValues[1].bcs));
  return { mintCost: cost, redeemPayout: payout };
}

export interface MarketQuoteInput {
  sender: string;
  oracleId: string;
  expiry: number | bigint;
  strike: bigint; // 1e9-scaled, on grid
  isUp: boolean;
  quantity: bigint; // DUSDC base units
}

export async function quoteMarket(
  client: SimulateCapableClient,
  p: MarketQuoteInput,
): Promise<TradeQuote> {
  const tx = new Transaction();
  tx.setSender(p.sender);
  const key = buildMarketKey(tx, {
    oracleId: p.oracleId,
    expiry: p.expiry,
    strike: p.strike,
    isUp: p.isUp,
  });
  tx.moveCall({
    target: `${predictConfig.packageId}::predict::get_trade_amounts`,
    arguments: [
      tx.object(predictConfig.predictObjectId),
      tx.object(p.oracleId),
      key,
      tx.pure.u64(p.quantity),
      tx.object(predictConfig.clockId),
    ],
  });
  const res = await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  return decodeTwoU64(res);
}

/** A chain quote plus the position size it was solved for. */
export interface StakeQuote extends TradeQuote {
  quantity: bigint; // payout-quantity whose mintCost ≈ the target stake (base units)
}

/**
 * Solve for the position size whose mint cost equals a target DUSDC stake — so
 * the trader pays exactly the amount they picked and the *payout* floats instead
 * of the cost.
 *
 * `mintCost(qty)` is monotone increasing in qty, but the utilization/inventory
 * part of the spread makes it non-linear, so a single secant step from a rough
 * seed can still land a cent or two off the stake (the "you pay 0.89 / 1.05"
 * flicker before it settles). We seed with `qtyGuess` (from the client fair),
 * then step `qty ← qty·stake/cost` — a fast fixed-point iteration — until within
 * `tolBase` or `maxSteps` is hit. It breaks the instant it's within tolerance, so
 * a good seed still costs 1–2 simulate calls; the extra budget only spends when a
 * poor seed (e.g. before the surface loads) or high curvature needs more refining,
 * which is what guarantees "you pay exactly what you picked" on the FIRST solve.
 * Returns the final quote AND the quantity it priced, ready to mint.
 */
export async function solveQuoteForStake(
  quoteFn: (quantity: bigint) => Promise<TradeQuote>,
  stakeBase: bigint,
  qtyGuess: bigint,
  opts: { maxSteps?: number; tolBase?: bigint } = {},
): Promise<StakeQuote> {
  const maxSteps = opts.maxSteps ?? 4;
  const tolBase = opts.tolBase ?? 2_000n; // 0.002 DUSDC — below display resolution
  let qty = qtyGuess > 0n ? qtyGuess : 1n;
  let q = await quoteFn(qty);
  for (let i = 0; i < maxSteps; i++) {
    if (q.mintCost === 0n) break;
    const diff = q.mintCost - stakeBase;
    if ((diff < 0n ? -diff : diff) <= tolBase) break;
    // Secant on the near-linear cost(qty): scale qty by stake / cost.
    const next = (qty * stakeBase) / q.mintCost;
    const nextQty = next > 0n ? next : 1n;
    if (nextQty === qty) break;
    qty = nextQty;
    q = await quoteFn(qty);
  }
  return { ...q, quantity: qty };
}

export interface RangeQuoteInput {
  sender: string;
  oracleId: string;
  expiry: number | bigint;
  lowerStrike: bigint;
  higherStrike: bigint;
  quantity: bigint;
}

export async function quoteRange(
  client: SimulateCapableClient,
  p: RangeQuoteInput,
): Promise<TradeQuote> {
  const tx = new Transaction();
  tx.setSender(p.sender);
  const key = buildRangeKey(tx, {
    oracleId: p.oracleId,
    expiry: p.expiry,
    lowerStrike: p.lowerStrike,
    higherStrike: p.higherStrike,
  });
  tx.moveCall({
    target: `${predictConfig.packageId}::predict::get_range_trade_amounts`,
    arguments: [
      tx.object(predictConfig.predictObjectId),
      tx.object(p.oracleId),
      key,
      tx.pure.u64(p.quantity),
      tx.object(predictConfig.clockId),
    ],
  });
  const res = await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  return decodeTwoU64(res);
}
