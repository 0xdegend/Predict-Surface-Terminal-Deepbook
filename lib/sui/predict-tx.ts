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

export interface CashOutParams {
  managerId: string;
  /** DUSDC base units to pull from the manager's free balance. */
  fromManager: bigint;
  /** DUSDC base units to pull from the connected wallet. */
  fromWallet: bigint;
  /** External Sui address to receive the DUSDC. */
  destination: string;
}

/**
 * Cash out DUSDC to an external wallet in ONE transaction: withdraw from the
 * manager's free balance and/or take wallet coins, merge, and transfer the lot
 * to `destination`. Used by zkLogin (Google) users to move winnings to a wallet
 * they fully control — executed gaslessly via the Enoki sponsor. The only Move
 * call is the allowlisted `predict_manager::withdraw`, so it sponsors cleanly.
 */
export function buildCashOutTx(p: CashOutParams): Transaction {
  const tx = new Transaction();
  const coins = [];
  if (p.fromManager > 0n) {
    coins.push(
      tx.moveCall({
        target: `${cfg().packageId}::predict_manager::withdraw`,
        typeArguments: [QUOTE()],
        arguments: [tx.object(p.managerId), tx.pure.u64(p.fromManager)],
      }),
    );
  }
  if (p.fromWallet > 0n) {
    coins.push(tx.add(coinWithBalance({ type: QUOTE(), balance: p.fromWallet })));
  }
  if (coins.length === 0) throw new Error('Nothing to cash out');
  const primary = coins[0];
  if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1));
  tx.transferObjects([primary], tx.pure.address(p.destination));
  return tx;
}

/* --------------------------- PLP (LP vault) -------------------------- */

/**
 * Supply DUSDC into the PLP vault (plain, un-hedged liquidity provision):
 *   predict::supply<Quote>(&mut Predict, Coin<Quote>, &Clock, &mut TxContext): Coin<PLP>
 * Mirrors the verified withdraw ABI. No PredictManager needed — PLP is a wallet
 * coin, so the returned Coin<PLP> is transferred straight to the owner. The
 * hedge router (buildOpenHedgedTx) wraps this same call plus a crash binary;
 * this is the leg on its own for users who don't want to hedge.
 */
export function buildSupplyTx(amount: bigint, owner: string): Transaction {
  const tx = new Transaction();
  const coin = tx.add(coinWithBalance({ type: QUOTE(), balance: amount }));
  const plp = tx.moveCall({
    target: `${cfg().packageId}::predict::supply`,
    typeArguments: [QUOTE()],
    arguments: [tx.object(cfg().predictObjectId), coin, tx.object(cfg().clockId)],
  });
  tx.transferObjects([plp], tx.pure.address(owner));
  return tx;
}

/**
 * Redeem PLP back to DUSDC. Verified against the deployed package ABI:
 *   predict::withdraw<Quote>(&mut Predict, Coin<PLP>, &Clock, &mut TxContext): Coin<Quote>
 * The returned DUSDC coin is transferred to the owner's wallet. `coinWithBalance`
 * auto-selects / splits the caller's PLP coins to the exact redeem amount.
 * Subject on-chain to the withdrawal limiter (see `available_withdrawal`).
 */
export function buildWithdrawPlpTx(plpAmount: bigint, owner: string): Transaction {
  const tx = new Transaction();
  const plp = tx.add(coinWithBalance({ type: cfg().plpCoinType, balance: plpAmount }));
  const out = tx.moveCall({
    target: `${cfg().packageId}::predict::withdraw`,
    typeArguments: [QUOTE()],
    arguments: [tx.object(cfg().predictObjectId), plp, tx.object(cfg().clockId)],
  });
  tx.transferObjects([out], tx.pure.address(owner));
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

/* --------------------------- hedge vault ----------------------------- */

export interface OpenHedgedParams {
  managerId: string;
  oracleId: string;
  expiry: number | bigint; // hedge oracle expiry (must match the oracle)
  hedgeStrike: bigint; // 1e9-scaled, on grid
  hedgeIsUp: boolean; // false = downside "crash" binary
  hedgeQuantity: bigint; // DUSDC base units (hedge contracts)
  hedgeBudget: bigint; // DUSDC base units funding the hedge mint
  supplyAmount: bigint; // DUSDC base units routed into PLP
}

/**
 * Atomic "PLP yield minus crash insurance" open via our predict_hedge router:
 * deposit the hedge budget → mint the OTM hedge into the caller's manager →
 * supply the rest into PLP (PLP returned to the caller). One signed transaction.
 * Requires `hedgePackageId` to be set for the active network.
 */
export function buildOpenHedgedTx(p: OpenHedgedParams): Transaction {
  const pkg = cfg().hedgePackageId;
  if (!pkg) throw new Error('Hedge router not deployed for this network');
  const tx = new Transaction();
  const hedgeBudget = tx.add(coinWithBalance({ type: QUOTE(), balance: p.hedgeBudget }));
  const supplyCoin = tx.add(coinWithBalance({ type: QUOTE(), balance: p.supplyAmount }));
  tx.moveCall({
    target: `${pkg}::hedged_position::open_hedged_and_keep`,
    typeArguments: [QUOTE()],
    arguments: [
      tx.object(cfg().predictObjectId),
      tx.object(p.managerId),
      tx.object(p.oracleId),
      tx.pure.u64(BigInt(p.expiry)),
      tx.pure.u64(p.hedgeStrike),
      tx.pure.bool(p.hedgeIsUp),
      tx.pure.u64(p.hedgeQuantity),
      hedgeBudget,
      supplyCoin,
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
