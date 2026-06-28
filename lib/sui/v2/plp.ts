/**
 * lib/sui/v2/plp.ts — the v2 PLP vault: ASYNC liquidity provision.
 *
 * Unlike the legacy inline supply/withdraw, v2 LP ops are QUEUED and filled at the
 * keeper's flush (NAV-priced), so the user actions only REQUEST:
 *   request_supply(amount DUSDC)  — pulls DUSDC from the account; PLP shares are
 *                                   delivered to the account at the next flush.
 *   request_withdraw(amount PLP)  — pulls PLP shares from the account; DUSDC is
 *                                   delivered to the account at the next flush.
 * Each returns a queue index used to cancel before the flush. Verified from
 * plp.move (predict-testnet-6-24). No public per-user request read exists, so the
 * cancel index must come from the request tx effects / the indexer (when it ships).
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config, v2Target } from '@/config/predict';
import { addGenerateAuth, addDeposit, type SimulateCapableClient } from './account';

const c = () => predictV2Config;

/* ------------------------------- builders -------------------------------- */

export interface RequestSupplyParams {
  wrapperId: string;
  /** DUSDC base units to commit to the vault. */
  amount: bigint;
  /** Optional: top up the account by this much DUSDC in the same PTB first. */
  deposit?: bigint;
}

/** Queue a vault deposit (DUSDC → PLP at next flush). */
export function buildRequestSupplyTx(p: RequestSupplyParams): Transaction {
  const tx = new Transaction();
  if (p.deposit && p.deposit > 0n) addDeposit(tx, p.wrapperId, p.deposit);
  const auth = addGenerateAuth(tx);
  tx.moveCall({
    target: v2Target('plp', 'request_supply'),
    arguments: [
      tx.object(c().shared.poolVault),
      tx.object(p.wrapperId),
      auth,
      tx.object(c().shared.protocolConfig),
      tx.pure.u64(p.amount),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

/** Queue a vault withdrawal (PLP shares → DUSDC at next flush). */
export function buildRequestWithdrawTx(wrapperId: string, plpAmount: bigint): Transaction {
  const tx = new Transaction();
  const auth = addGenerateAuth(tx);
  tx.moveCall({
    target: v2Target('plp', 'request_withdraw'),
    arguments: [
      tx.object(c().shared.poolVault),
      tx.object(wrapperId),
      auth,
      tx.object(c().shared.protocolConfig),
      tx.pure.u64(plpAmount),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

function buildCancelTx(fn: 'cancel_supply_request' | 'cancel_withdraw_request', wrapperId: string, index: bigint): Transaction {
  const tx = new Transaction();
  const auth = addGenerateAuth(tx);
  tx.moveCall({
    target: v2Target('plp', fn),
    arguments: [
      tx.object(c().shared.poolVault),
      tx.object(wrapperId),
      auth,
      tx.object(c().shared.protocolConfig),
      tx.pure.u64(index),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

export const buildCancelSupplyTx = (wrapperId: string, index: bigint) =>
  buildCancelTx('cancel_supply_request', wrapperId, index);
export const buildCancelWithdrawTx = (wrapperId: string, index: bigint) =>
  buildCancelTx('cancel_withdraw_request', wrapperId, index);

/* -------------------------------- reads ---------------------------------- */

export interface VaultState {
  idleBalance: bigint; // DUSDC base units available for funding/withdrawals
  plpTotalSupply: bigint; // PLP shares outstanding
  supplyPending: bigint; // count of un-flushed supply requests
  withdrawPending: bigint; // count of un-flushed withdraw requests
  protocolReserve: bigint; // DUSDC base units
  feeIncentiveReserve: bigint; // DUSDC base units
  stakedDeep: bigint;
}

const SIM_SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

// View functions (all take &PoolVault, return u64), called in this order.
const VAULT_VIEWS = [
  'idle_balance',
  'plp_total_supply',
  'supply_requests_pending',
  'withdraw_requests_pending',
  'protocol_reserve_balance',
  'fee_incentive_reserve',
  'staked_deep',
] as const;

/** Read the vault's on-chain state via a single simulate of the view functions. */
export async function readVaultState(client: SimulateCapableClient): Promise<VaultState> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  for (const fn of VAULT_VIEWS) {
    tx.moveCall({ target: v2Target('plp', fn), arguments: [tx.object(c().shared.poolVault)] });
  }
  const res = (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as { $kind: string; commandResults?: { returnValues: { bcs: Uint8Array }[] }[] };
  const cmds = res.commandResults ?? [];
  if (cmds.length < VAULT_VIEWS.length) throw new Error('readVaultState: simulate returned too few values');
  const u = (i: number) => BigInt(bcs.u64().parse(new Uint8Array(cmds[i].returnValues[0].bcs)));
  return {
    idleBalance: u(0),
    plpTotalSupply: u(1),
    supplyPending: u(2),
    withdrawPending: u(3),
    protocolReserve: u(4),
    feeIncentiveReserve: u(5),
    stakedDeep: u(6),
  };
}
