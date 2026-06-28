/**
 * lib/sui/v2/predict-tx.ts — PTB builders for the v2 trade flows.
 *
 * Pure Transaction construction (no wallet/client). Hand the result to
 * dAppKit.signAndExecuteTransaction. All flows build a fresh `Pricer` inline via
 * load_live_pricer and pass it into the call (the protocol prices per-tx).
 *
 * Verified signatures (predict-testnet-6-24): mint_exact_quantity is NOT generic
 * (DUSDC is baked into the pool); quantity is 6-dec base units (1e6 = $1 max
 * payout); leverage/max_probability are 1e9-scaled; orders are u256 ids returned
 * by mint and consumed by redeem. `Auth` is consumed per call — see account.ts.
 */
import { Transaction } from '@mysten/sui/transactions';
import { predictV2Config, v2Target } from '@/config/predict';
import { buildLoadPricerCall } from './pricer';
import { addGenerateAuth, addDeposit } from './account';

const c = () => predictV2Config;

export interface MintParams {
  marketId: string;
  wrapperId: string;
  /** Range as tick indices — use lib/sui/v2/ticks (binaryTicks / rangeTicks). */
  lowerTick: bigint;
  higherTick: bigint;
  /** Max payout in DUSDC base units (1e6 = $1). */
  quantity: bigint;
  /** 1e9-scaled (1e9 = 1x). */
  leverage: bigint;
  /** All-in cost cap (DUSDC base units) — slippage guard. */
  maxCost: bigint;
  /** Entry probability cap (1e9-scaled) — slippage guard. */
  maxProbability: bigint;
  /** Optional: deposit this many base units into the wrapper in the same PTB first. */
  deposit?: bigint;
}

/**
 * mint_exact_quantity — open a position of exactly `quantity` max-payout.
 * Optionally pre-funds the wrapper in the same PTB. Returns the tx; the new
 * order id (u256) is read from the OrderMinted event in the effects.
 */
export function buildMintTx(p: MintParams): Transaction {
  const tx = new Transaction();
  if (p.deposit && p.deposit > 0n) addDeposit(tx, p.wrapperId, p.deposit);
  const auth = addGenerateAuth(tx);
  const pricer = buildLoadPricerCall(tx, p.marketId);
  tx.moveCall({
    target: v2Target('expiry_market', 'mint_exact_quantity'),
    arguments: [
      tx.object(p.marketId),
      tx.object(p.wrapperId),
      auth,
      tx.object(c().shared.protocolConfig),
      pricer,
      tx.pure.u64(p.lowerTick),
      tx.pure.u64(p.higherTick),
      tx.pure.u64(p.quantity),
      tx.pure.u64(p.leverage),
      tx.pure.u64(p.maxCost),
      tx.pure.u64(p.maxProbability),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

export interface RedeemParams {
  marketId: string;
  wrapperId: string;
  orderId: bigint; // u256
  /** Base units to close (0/equal-to-open = full close). */
  closeQuantity: bigint;
}

/** redeem_live — close (part of) a position on a still-live market (needs a Pricer). */
export function buildRedeemLiveTx(p: RedeemParams): Transaction {
  const tx = new Transaction();
  const auth = addGenerateAuth(tx);
  const pricer = buildLoadPricerCall(tx, p.marketId);
  tx.moveCall({
    target: v2Target('expiry_market', 'redeem_live'),
    arguments: [
      tx.object(p.marketId),
      tx.object(p.wrapperId),
      auth,
      tx.object(c().shared.protocolConfig),
      pricer,
      tx.pure.u256(p.orderId),
      tx.pure.u64(p.closeQuantity),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

/**
 * redeem_settled — claim a settled position. Uses the settlement price (no live
 * Pricer, no Auth — the payout is deterministic); takes the account + propbook
 * registries and the pyth feed instead. Payout lands in the owner's account.
 */
export function buildRedeemSettledTx(p: RedeemParams): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: v2Target('expiry_market', 'redeem_settled'),
    arguments: [
      tx.object(p.marketId),
      tx.object(c().shared.accountRegistry),
      tx.object(p.wrapperId),
      tx.object(c().shared.protocolConfig),
      tx.object(c().shared.oracleRegistry),
      tx.object(c().asset.pythFeedId),
      tx.pure.u256(p.orderId),
      tx.pure.u64(p.closeQuantity),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}
