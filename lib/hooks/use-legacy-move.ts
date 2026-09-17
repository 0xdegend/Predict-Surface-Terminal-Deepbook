'use client';

/**
 * useLegacyMove — the one place that moves a trader's USDC off a retired release.
 *
 * Two surfaces need this and must not drift apart: the portfolio banner (for someone who
 * already has an account here) and the first-run create card (for someone who does not,
 * where creating the account and bringing the money across are the same transaction).
 * Duplicating the builder call across both would be duplicating a money path.
 *
 * The move is a SINGLE transaction either way. A PTB may call into more than one package,
 * and the Coin that `withdraw_funds` returns on the old package goes straight into
 * `deposit_funds` on the new one without touching the wallet. When there is no account yet
 * the registry hands back the AccountWrapper by value, so it is deposited into and only
 * then shared. Being atomic is the point: there is no in-between state where the money has
 * left the old account but not arrived, so a failure has exactly one meaning.
 */
import { useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useLegacyFunds, qkLegacyFunds } from '@/lib/hooks/use-legacy-funds';
import { buildLegacyMoveTx, buildLegacyWithdrawTx } from '@/lib/sui/v2/legacy-account';
import { predictV2Config, predictConfigFor } from '@/config/predict';

export type LegacyMovePhase = 'idle' | 'moving' | 'done' | 'error';

/**
 * Below this, leave it alone (base units — 0.01 USDC).
 *
 * Deliberately tiny. The floor exists only to stop a rounding remainder of a fraction of a
 * cent putting a prompt in front of someone forever, since a withdraw can leave dust
 * behind. It is NOT a judgment about what is worth reclaiming: a real leftover balance is
 * the trader's money whatever its size, and the first wallet checked had 3.11 USDC on a
 * release nobody had looked at in a month.
 */
export const MIN_RECLAIM_BASE = 10_000n;

export function useLegacyMove() {
  const acct = usePredictAccountV2();
  const owner = acct.owner ?? null;
  const legacy = useLegacyFunds(owner);
  /** The coin sitting on the OLD release. Not the active ticker: from 9-12 on these are
   *  different coins, and calling the stranded balance by the new name is exactly the
   *  confusion the banner exists to prevent. */
  const oldSym = legacy.deployment ? predictConfigFor(legacy.deployment).quote.symbol : predictV2Config.quote.symbol;

  const [phase, setPhase] = useState<LegacyMovePhase>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const amount = legacy.balanceBase;
  const hasFunds = amount >= MIN_RECLAIM_BASE && !!legacy.wrapperId && !!legacy.deployment;

  async function move() {
    if (!owner || !legacy.wrapperId || !legacy.deployment) return false;
    // Only act on a wrapper state we actually READ. `wrapperExists` defaults to false, so
    // acting while the read is in flight could ask the chain to create an account that
    // already exists — which aborts the whole move.
    if (!acct.wrapperKnown) return false;
    // If the read says an account exists it must also have told us which one. Bailing is
    // better than depositing into a guessed address.
    if (acct.wrapperExists && !acct.wrapperId) return false;

    setErrMsg(null);
    setPhase('moving');
    const ok = await acct.runTx(
      'legacy-move',
      buildLegacyMoveTx({
        from: legacy.deployment,
        oldWrapperId: legacy.wrapperId,
        newWrapperId: acct.wrapperId ?? '',
        amount,
        createAccount: !acct.wrapperExists,
      }),
      [qkLegacyFunds(owner, legacy.deployment)],
    );
    legacy.refetch();
    if (!ok) {
      // Atomic, so there is exactly one true thing to say: nothing moved.
      setErrMsg(`We couldn't move your ${oldSym} just now. It is still in your old account.`);
      setPhase('error');
      return false;
    }
    setPhase('done');
    return true;
  }

  /**
   * Withdraw the old balance to the trader's WALLET.
   *
   * The only thing on offer when `canMove` is false. From 9-12 the old coin cannot enter
   * the new account at all (different Move type, no swap), so "bring it across" is not a
   * slower path, it is an impossible one. Getting the coin out of a dead account and into
   * the wallet is the whole of what can be done, and it is still the trader's money.
   */
  async function withdraw() {
    if (!owner || !legacy.wrapperId || !legacy.deployment) return false;
    setErrMsg(null);
    setPhase('moving');
    const ok = await acct.runTx(
      'legacy-withdraw',
      buildLegacyWithdrawTx(legacy.wrapperId, amount, owner, legacy.deployment),
      [qkLegacyFunds(owner, legacy.deployment)],
    );
    legacy.refetch();
    if (!ok) {
      setErrMsg(`We couldn't withdraw your ${oldSym} just now. It is still in your old account.`);
      setPhase('error');
      return false;
    }
    setPhase('done');
    return true;
  }

  return {
    /** The old release's balance, base units. */
    amount,
    /**
     * Whether the balance can be carried into the new account, or only withdrawn to the
     * wallet. False whenever the two releases settle in different coins (9-12 is the first).
     * Callers MUST branch on this: the chain rejects the mismatched move only AFTER the
     * trader has signed.
     */
    canMove: legacy.canMove,
    /** How the old coin is written: the OLD release's ticker, not the active one. */
    oldSym,
    withdraw,
    /** True only when there is a real balance worth offering to move. */
    hasFunds,
    /** Which release the funds are on, or null when there is no previous deployment. */
    deployment: legacy.deployment,
    /** True while the old-release balance is still being read — callers that choose
     *  BETWEEN two screens on this answer should wait rather than guess and flash. */
    isLoading: legacy.isLoading,
    /** True when this move will also create the trader's account here. */
    createsAccount: acct.wrapperKnown && !acct.wrapperExists,
    phase,
    errMsg,
    move,
    /** Ready to sign: the account state has been read, so `createAccount` is not a guess. */
    ready: acct.wrapperKnown,
  };
}
