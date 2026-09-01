'use client';

/**
 * useLegacyMove — the one place that moves a trader's DUSDC off a retired release.
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
import { buildLegacyMoveTx } from '@/lib/sui/v2/legacy-account';
import { predictV2Config } from '@/config/predict';

export type LegacyMovePhase = 'idle' | 'moving' | 'done' | 'error';

/**
 * Below this, leave it alone (base units — 0.01 DUSDC).
 *
 * Deliberately tiny. The floor exists only to stop a rounding remainder of a fraction of a
 * cent putting a prompt in front of someone forever, since a withdraw can leave dust
 * behind. It is NOT a judgment about what is worth reclaiming: a real leftover balance is
 * the trader's money whatever its size, and the first wallet checked had 3.11 DUSDC on a
 * release nobody had looked at in a month.
 */
export const MIN_RECLAIM_BASE = 10_000n;

export function useLegacyMove() {
  const acct = usePredictAccountV2();
  const owner = acct.owner ?? null;
  const legacy = useLegacyFunds(owner);
  const sym = predictV2Config.quote.symbol;

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
      setErrMsg(`We couldn't move your ${sym} just now. It is still in your old account.`);
      setPhase('error');
      return false;
    }
    setPhase('done');
    return true;
  }

  return {
    /** DUSDC still on the old release, base units. */
    amount,
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
