/**
 * lib/sui/predict-tx.ts — PTB builders for the Predict flows.
 *
 * Pure Transaction construction (no wallet, no client). Hand the returned
 * Transaction to dAppKit.signAndExecuteTransaction. Targets/types/IDs come from
 * config/predict.ts so a mainnet swap stays a one-place change.
 *
 * Flow notes (confirmed from source):
 *  - create_manager(ctx): ID shares the manager internally → MUST be its own tx;
 *    a freshly created shared object cannot be an input in the same PTB.
 *  - mint withdraws `cost` from the manager's inner BalanceManager, so the
 *    manager must hold >= cost DUSDC. We deposit (optional) then mint in one PTB.
 *  - redeem / redeem_range deposit the payout back INTO the manager (not wallet).
 *    Cashing out to the wallet is a separate predict_manager::withdraw.
 *  - quantity is in DUSDC base units (6 dec): 1_000_000 = 1 contract = $1 max payout.
 */
import { Transaction } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';
import { predictConfig } from '@/config/predict';
import { buildMarketKey, buildRangeKey } from '@/lib/keys';

const cfg = () => predictConfig;
const QUOTE = () => predictConfig.quote.coinType;

/* ----------------------------- manager ----------------------------- */

/** create_manager(ctx): ID — standalone tx. New manager id is read from effects. */
export function buildCreateManagerTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${cfg().packageId}::predict::create_manager` });
  return tx;
}

/** Deposit DUSDC from the wallet into the PredictManager (owner-gated). */
export function buildDepositTx(managerId: string, amount: bigint): Transaction {
  const tx = new Transaction();
  depositInto(tx, managerId, amount);
  return tx;
}

function depositInto(tx: Transaction, managerId: string, amount: bigint) {
  const coin = tx.add(coinWithBalance({ type: QUOTE(), balance: amount }));
  tx.moveCall({
    target: `${cfg().packageId}::predict_manager::deposit`,
    typeArguments: [QUOTE()],
    arguments: [tx.object(managerId), coin],
  });
}

/** Withdraw DUSDC from the manager back to the owner's wallet. */
export function buildWithdrawFromManagerTx(
  managerId: string,
  amount: bigint,
  owner: string,
): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${cfg().packageId}::predict_manager::withdraw`,
    typeArguments: [QUOTE()],
    arguments: [tx.object(managerId), tx.pure.u64(amount)],
  });
  tx.transferObjects([coin], tx.pure.address(owner));
  return tx;
}

/* ------------------------------- binary ------------------------------ */

export interface MintParams {
  managerId: string;
  oracleId: string;
  expiry: number | bigint;
  strike: bigint; // 1e9-scaled, on grid
  isUp: boolean;
  quantity: bigint; // DUSDC base units (max payout)
  /** Optional pre-deposit (DUSDC base units) folded into the same PTB. */
  depositAmount?: bigint;
}

/** Optional deposit + mint a binary, in one transaction. */
export function buildMintTx(p: MintParams): Transaction {
  const tx = new Transaction();
  if (p.depositAmount && p.depositAmount > 0n) {
    depositInto(tx, p.managerId, p.depositAmount);
  }
  const key = buildMarketKey(tx, {
    oracleId: p.oracleId,
    expiry: p.expiry,
    strike: p.strike,
    isUp: p.isUp,
  });
  tx.moveCall({
    target: `${cfg().packageId}::predict::mint`,
    typeArguments: [QUOTE()],
    arguments: [
      tx.object(cfg().predictObjectId),
      tx.object(p.managerId),
      tx.object(p.oracleId),
      key,
      tx.pure.u64(p.quantity),
      tx.object(cfg().clockId),
    ],
  });
  return tx;
}

export interface RedeemParams {
  managerId: string;
  oracleId: string;
  expiry: number | bigint;
  strike: bigint;
  isUp: boolean;
  quantity: bigint;
  /** Use redeem_permissionless (only valid once the oracle is settled). */
  settled?: boolean;
}

/** Redeem a binary; payout lands in the manager's balance. */
export function buildRedeemTx(p: RedeemParams): Transaction {
  const tx = new Transaction();
  const key = buildMarketKey(tx, {
    oracleId: p.oracleId,
    expiry: p.expiry,
    strike: p.strike,
    isUp: p.isUp,
  });
  tx.moveCall({
    target: `${cfg().packageId}::predict::${p.settled ? 'redeem_permissionless' : 'redeem'}`,
    typeArguments: [QUOTE()],
    arguments: [
      tx.object(cfg().predictObjectId),
      tx.object(p.managerId),
      tx.object(p.oracleId),
      key,
      tx.pure.u64(p.quantity),
      tx.object(cfg().clockId),
    ],
  });
  return tx;
}

/* ------------------------------- range ------------------------------- */

export interface RangeMintParams {
  managerId: string;
  oracleId: string;
  expiry: number | bigint;
  lowerStrike: bigint;
  higherStrike: bigint;
  quantity: bigint;
  depositAmount?: bigint;
}

export function buildMintRangeTx(p: RangeMintParams): Transaction {
  const tx = new Transaction();
  if (p.depositAmount && p.depositAmount > 0n) {
    depositInto(tx, p.managerId, p.depositAmount);
  }
  const key = buildRangeKey(tx, {
    oracleId: p.oracleId,
    expiry: p.expiry,
    lowerStrike: p.lowerStrike,
    higherStrike: p.higherStrike,
  });
  tx.moveCall({
    target: `${cfg().packageId}::predict::mint_range`,
    typeArguments: [QUOTE()],
    arguments: [
      tx.object(cfg().predictObjectId),
      tx.object(p.managerId),
      tx.object(p.oracleId),
      key,
      tx.pure.u64(p.quantity),
      tx.object(cfg().clockId),
    ],
  });
  return tx;
}

export interface RangeRedeemParams {
  managerId: string;
  oracleId: string;
  expiry: number | bigint;
  lowerStrike: bigint;
  higherStrike: bigint;
  quantity: bigint;
}

export function buildRedeemRangeTx(p: RangeRedeemParams): Transaction {
  const tx = new Transaction();
  const key = buildRangeKey(tx, {
    oracleId: p.oracleId,
    expiry: p.expiry,
    lowerStrike: p.lowerStrike,
    higherStrike: p.higherStrike,
  });
  tx.moveCall({
    target: `${cfg().packageId}::predict::redeem_range`,
    typeArguments: [QUOTE()],
    arguments: [
      tx.object(cfg().predictObjectId),
      tx.object(p.managerId),
      tx.object(p.oracleId),
      key,
      tx.pure.u64(p.quantity),
      tx.object(cfg().clockId),
    ],
  });
  return tx;
}
