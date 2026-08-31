/**
 * legacy-account.ts — reading and emptying a trading account on a deployment we have
 * already moved off.
 *
 * A redeploy strands money. The AccountWrapper, the registry that derives its address, and
 * the DUSDC sitting inside it all belong to the release that created them, so cutting over
 * to a new deployment does not move a trader's balance — it stops the app from ever looking
 * at where the balance is. Nothing is lost on chain, but from inside the app it may as well
 * be, because every read is pointed at the new registry.
 *
 * The rest of lib/sui/v2 resolves its ids through `predictV2Config`, i.e. whichever
 * deployment is active. These builders take the deployment explicitly instead, so the app
 * can read one release while trading on another. That is the whole difference; the calls
 * themselves are the same ones account.ts makes.
 *
 * ONE TRANSACTION, not three. A PTB is not restricted to a single package, and the DUSDC
 * that `withdraw_funds` returns on the old package is just a `Coin` — it can be handed
 * straight to `deposit_funds` on the new one without ever landing in the wallet. When the
 * trader has no account on the new release yet, the create goes in the same PTB: the
 * registry hands back the AccountWrapper BY VALUE, so it can be deposited into and only
 * then shared, which is why the usual "you cannot use a shared object in the transaction
 * that creates it" rule does not bite here.
 *
 * That makes the move atomic, which is the real win. The alternative was three signatures
 * with two states in between where the money is somewhere the trader did not ask for, and
 * a half-finished move to explain. Here it either happens or nothing happens.
 *
 * Both shapes are verified against the live chain by simulation, at the full balance, not
 * a test amount — see legacy-account.live.test.ts.
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictConfigFor, predictV2Config, type PredictDeployment } from '@/config/predict';
import { SIM_SENDER, simulate, type SimulateCapableClient } from './account';

/** What a trader still has on a deployment we have left. */
export interface LegacyFunds {
  deployment: PredictDeployment;
  /** The old wrapper, or null when this wallet never had an account there. */
  wrapperId: string | null;
  /** DUSDC still in that account, in base units. 0n when there is nothing to reclaim. */
  balanceBase: bigint;
}

/**
 * Read a wallet's account balance on `deployment`.
 *
 * One simulate covering all three steps, so a wallet with no old account costs a single
 * round trip. Returns a zero balance rather than throwing when the account does not exist,
 * because "never traded on the old release" is the common case, not an error.
 */
export async function readLegacyFunds(
  client: SimulateCapableClient,
  owner: string,
  deployment: PredictDeployment,
): Promise<LegacyFunds> {
  const cfg = predictConfigFor(deployment);
  const acc = (module: string, fn: string) => `${cfg.packages.account}::${module}::${fn}` as const;

  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  tx.moveCall({
    target: acc('account_registry', 'derived_wrapper_address'),
    arguments: [tx.object(cfg.shared.accountRegistry), tx.pure.address(owner)],
  });
  tx.moveCall({
    target: acc('account_registry', 'derived_wrapper_exists'),
    arguments: [tx.object(cfg.shared.accountRegistry), tx.pure.address(owner)],
  });

  const res = await simulate(client, tx);
  const cmds = res.commandResults ?? [];
  if (cmds.length < 2) throw new Error('readLegacyFunds: simulate returned no values');
  const wrapperId = bcs.Address.parse(new Uint8Array(cmds[0].returnValues[0].bcs));
  const exists = bcs.bool().parse(new Uint8Array(cmds[1].returnValues[0].bcs));
  if (!exists) return { deployment, wrapperId: null, balanceBase: 0n };

  // Balance is a second simulate: `load_account` needs the wrapper to exist, and asking for
  // it in the same PTB would abort the whole read for every wallet that has no old account.
  const balTx = new Transaction();
  balTx.setSender(SIM_SENDER);
  const account = balTx.moveCall({
    target: acc('account', 'load_account'),
    arguments: [balTx.object(wrapperId)],
  });
  balTx.moveCall({
    target: acc('account', 'balance'),
    typeArguments: [cfg.quote.coinType],
    // (&Account, &AccumulatorRoot, &Clock) — verified against the live package ABI on both
    // deployments, not copied from the active-deployment reader.
    arguments: [account, balTx.object(cfg.accumulatorRootId), balTx.object(cfg.clockId)],
  });
  const balRes = await simulate(client, balTx);
  const balCmds = balRes.commandResults ?? [];
  const raw = balCmds[balCmds.length - 1]?.returnValues?.[0]?.bcs;
  const balanceBase = raw ? BigInt(bcs.u64().parse(new Uint8Array(raw))) : 0n;
  return { deployment, wrapperId, balanceBase };
}

/**
 * Withdraw everything from an old account into the trader's wallet.
 *
 * `amount` is passed explicitly rather than read inside the transaction: the balance was
 * already read to decide whether to offer this at all, and asking the chain again mid-PTB
 * would let a concurrent settlement change the number between the two reads. Withdrawing a
 * stale-but-smaller amount leaves dust, which the banner will simply offer again;
 * withdrawing more than the account holds would abort.
 */
export function buildLegacyWithdrawTx(
  wrapperId: string,
  amount: bigint,
  owner: string,
  deployment: PredictDeployment,
): Transaction {
  const cfg = predictConfigFor(deployment);
  const acc = (module: string, fn: string) => `${cfg.packages.account}::${module}::${fn}` as const;

  const tx = new Transaction();
  const auth = tx.moveCall({ target: acc('account', 'generate_auth') });
  const coin = tx.moveCall({
    target: acc('account', 'withdraw_funds'),
    typeArguments: [cfg.quote.coinType],
    // (&AccountWrapper, Auth, u64, &AccumulatorRoot, &Clock) — five, verified against the
    // live ABI. A missing argument here does not fail to build, it aborts a signed
    // transaction whose whole purpose is recovering stranded money.
    arguments: [
      tx.object(wrapperId),
      auth,
      tx.pure.u64(amount),
      tx.object(cfg.accumulatorRootId),
      tx.object(cfg.clockId),
    ],
  });
  tx.transferObjects([coin], tx.pure.address(owner));
  return tx;
}

/**
 * Move everything from the old account into the new one, in a single transaction.
 *
 * `createAccount` decides whether the new account has to be made first. Pass what
 * `readWrapper` reported rather than guessing: calling `account_registry::new` for a
 * wallet that already has an account aborts, and skipping it for one that does not aborts
 * on the deposit. Either way the whole transaction reverts and nothing moves, so this is a
 * failed move rather than a lost one — but it is still a signature spent on nothing.
 *
 * `amount` is read before building rather than inside the PTB: the balance was already
 * fetched to decide whether to offer the move at all, and re-reading mid-transaction would
 * let a concurrent settlement change the number underneath. Too small leaves dust, which
 * the banner offers again; too large would abort.
 */
export function buildLegacyMoveTx(p: {
  from: PredictDeployment;
  oldWrapperId: string;
  newWrapperId: string;
  amount: bigint;
  createAccount: boolean;
}): Transaction {
  const from = predictConfigFor(p.from);
  const to = predictV2Config;
  const oldAcc = (m: string, f: string) => `${from.packages.account}::${m}::${f}` as const;
  const newAcc = (m: string, f: string) => `${to.packages.account}::${m}::${f}` as const;

  const tx = new Transaction();

  // Out of the old account. The Auth is a hot potato minted per gated call, so the new
  // package needs its own below rather than reusing this one.
  const oldAuth = tx.moveCall({ target: oldAcc('account', 'generate_auth') });
  const coin = tx.moveCall({
    target: oldAcc('account', 'withdraw_funds'),
    typeArguments: [from.quote.coinType],
    arguments: [
      tx.object(p.oldWrapperId),
      oldAuth,
      tx.pure.u64(p.amount),
      tx.object(from.accumulatorRootId),
      tx.object(from.clockId),
    ],
  });

  // The wrapper to deposit into: either the shared one that already exists, or a brand new
  // one still held by value in this PTB.
  const wrapper = p.createAccount
    ? tx.moveCall({
        target: newAcc('account_registry', 'new'),
        arguments: [tx.object(to.shared.accountRegistry)],
      })
    : tx.object(p.newWrapperId);

  const newAuth = tx.moveCall({ target: newAcc('account', 'generate_auth') });
  tx.moveCall({
    target: newAcc('account', 'deposit_funds'),
    typeArguments: [to.quote.coinType],
    arguments: [wrapper, newAuth, coin, tx.object(to.accumulatorRootId), tx.object(to.clockId)],
  });

  // Share LAST. Sharing first would make the wrapper a shared input to a transaction that
  // created it, which is exactly the thing that is not allowed.
  if (p.createAccount) tx.moveCall({ target: newAcc('account', 'share'), arguments: [wrapper] });
  return tx;
}
