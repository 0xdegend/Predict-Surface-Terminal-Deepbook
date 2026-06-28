/**
 * lib/sui/v2/account.ts — the v2 custody model (account package).
 *
 * Replaces the legacy PredictManager. Each owner has a deterministic, shared
 * `AccountWrapper`; funds live behind a shared `AccumulatorRoot`. `Auth` is a
 * consume-by-value hot potato minted per gated call (`generate_auth`), so a tx
 * that deposits AND mints needs two of them.
 *
 * Flow note: `account_registry::new` shares the wrapper internally, so creating
 * it MUST be its own tx (a freshly-shared object can't be an input in the same
 * PTB) — same constraint the legacy create_manager had. Deposit + mint then
 * compose in a later PTB. Signatures verified from source (predict-testnet-6-24).
 */
import { Transaction, coinWithBalance, type TransactionResult } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config } from '@/config/predict';

const c = () => predictV2Config;
const ACC = (module: string, fn: string) => `${c().packages.account}::${module}::${fn}` as const;

/* ------------------------------- builders -------------------------------- */

/** Add `account::generate_auth(ctx): Auth` and return the Auth handle. */
export function addGenerateAuth(tx: Transaction): TransactionResult {
  return tx.moveCall({ target: ACC('account', 'generate_auth') });
}

/**
 * Create + share the caller's AccountWrapper. Standalone tx — the new shared
 * wrapper can't be used in the same PTB. Its id is read from the tx effects
 * (created shared object) or via `readWrapper`.
 */
export function buildCreateAccountTx(): Transaction {
  const tx = new Transaction();
  const wrapper = tx.moveCall({
    target: ACC('account_registry', 'new'),
    arguments: [tx.object(c().shared.accountRegistry)],
  });
  tx.moveCall({ target: ACC('account', 'share'), arguments: [wrapper] });
  return tx;
}

/** Add a DUSDC deposit into the wrapper (generate_auth + deposit_funds). */
export function addDeposit(tx: Transaction, wrapperId: string, amount: bigint): void {
  const auth = addGenerateAuth(tx);
  const coin = tx.add(coinWithBalance({ type: c().quote.coinType, balance: amount }));
  tx.moveCall({
    target: ACC('account', 'deposit_funds'),
    typeArguments: [c().quote.coinType],
    arguments: [
      tx.object(wrapperId),
      auth,
      coin,
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
}

export function buildDepositTx(wrapperId: string, amount: bigint): Transaction {
  const tx = new Transaction();
  addDeposit(tx, wrapperId, amount);
  return tx;
}

/** Withdraw DUSDC from the wrapper back to the owner's wallet. */
export function buildWithdrawTx(wrapperId: string, amount: bigint, owner: string): Transaction {
  const tx = new Transaction();
  const auth = addGenerateAuth(tx);
  const coin = tx.moveCall({
    target: ACC('account', 'withdraw_funds'),
    typeArguments: [c().quote.coinType],
    arguments: [
      tx.object(wrapperId),
      auth,
      tx.pure.u64(amount),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  tx.transferObjects([coin], tx.pure.address(owner));
  return tx;
}

/* -------------------------------- reads ---------------------------------- */

export interface SimulateCapableClient {
  simulateTransaction: (opts: {
    transaction: Transaction;
    include?: { commandResults?: boolean };
    checksEnabled?: boolean;
  }) => Promise<unknown>;
}

interface SimResult {
  $kind: string;
  commandResults?: { returnValues: { bcs: Uint8Array }[] }[];
  FailedTransaction?: { status?: { error?: unknown } };
}

const SIM_SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

async function simulate(client: SimulateCapableClient, tx: Transaction): Promise<SimResult> {
  return (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as SimResult;
}

/** The deterministic wrapper address for an owner, and whether it exists yet. */
export interface WrapperInfo {
  wrapperId: string;
  exists: boolean;
}

export async function readWrapper(
  client: SimulateCapableClient,
  owner: string,
): Promise<WrapperInfo> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  tx.moveCall({
    target: ACC('account_registry', 'derived_wrapper_address'),
    arguments: [tx.object(c().shared.accountRegistry), tx.pure.address(owner)],
  });
  tx.moveCall({
    target: ACC('account_registry', 'derived_wrapper_exists'),
    arguments: [tx.object(c().shared.accountRegistry), tx.pure.address(owner)],
  });
  const res = await simulate(client, tx);
  const cmds = res.commandResults ?? [];
  if (cmds.length < 2) throw new Error('readWrapper: simulate returned no values');
  const wrapperId = bcs.Address.parse(new Uint8Array(cmds[0].returnValues[0].bcs));
  const exists = bcs.bool().parse(new Uint8Array(cmds[1].returnValues[0].bcs));
  return { wrapperId, exists };
}

/**
 * Free balance of `coinType` in the wrapper's account (base units). Defaults to
 * DUSDC; pass the PLP type to read custodied vault shares.
 */
export async function readBalance(
  client: SimulateCapableClient,
  wrapperId: string,
  coinType: string = c().quote.coinType,
): Promise<bigint> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  const account = tx.moveCall({
    target: ACC('account', 'load_account'),
    arguments: [tx.object(wrapperId)],
  });
  tx.moveCall({
    target: ACC('account', 'balance'),
    typeArguments: [coinType],
    arguments: [account, tx.object(c().accumulatorRootId), tx.object(c().clockId)],
  });
  const res = await simulate(client, tx);
  const last = res.commandResults?.at(-1);
  if (!last?.returnValues?.length) throw new Error('readBalance: no value');
  return BigInt(bcs.u64().parse(new Uint8Array(last.returnValues[0].bcs)));
}
