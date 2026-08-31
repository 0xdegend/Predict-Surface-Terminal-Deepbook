'use client';

/**
 * LegacyFundsBanner — "your money is on the old release, here is the button".
 *
 * A redeploy strands funds. Accounts belong to the release that created them, so cutting
 * over does not move a balance; it stops the app from looking at where the balance is. From
 * the trader's side their portfolio simply reads zero, with nothing on screen explaining
 * why or offering a way back. The money is entirely theirs and entirely unreachable.
 *
 * SELF-GATING, like RewardBanner: renders null unless this specific wallet actually has a
 * leftover balance on the previous deployment. Nobody who joined after the cutover, and
 * nobody who has already reclaimed, ever sees it. It is also dismissable per wallet, because
 * a trader may reasonably want to deal with it later and should not be nagged every visit.
 *
 * The button is presented as one action but is up to three transactions: withdraw from the
 * old account, create the new one if it does not exist yet, then deposit. It runs in that
 * order on purpose. The withdraw comes FIRST so that if anything afterwards fails the money
 * is already sitting in the trader's own wallet rather than in limbo, and the banner can
 * simply offer the remaining steps again.
 */
import { useState } from 'react';
import { LuArrowRightLeft } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useLegacyFunds, qkLegacyFunds } from '@/lib/hooks/use-legacy-funds';
import { buildLegacyWithdrawTx } from '@/lib/sui/v2/legacy-account';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';

type Phase = 'idle' | 'moving' | 'done' | 'error';

/**
 * Below this, leave it alone (base units — 0.01 DUSDC).
 *
 * Deliberately tiny. The floor exists only to stop a rounding remainder of a fraction of a
 * cent putting a banner on someone's portfolio forever, since a withdraw can leave dust
 * behind. It is NOT a judgment about what is worth reclaiming: a real leftover balance is
 * the trader's money whatever its size, and the first wallet checked had 3.11 DUSDC sitting
 * on a release nobody had looked at in a month.
 */
const MIN_RECLAIM_BASE = 10_000n;

/** Dismissals are per wallet and persisted: "later" should mean later, not until reload. */
const dismissKey = (owner: string) => `skew.legacy-funds.dismissed.${owner.toLowerCase()}`;

function readDismissed(owner: string | null): boolean {
  if (!owner) return false;
  try {
    return localStorage.getItem(dismissKey(owner)) === '1';
  } catch {
    return false; // private mode / blocked storage: show it rather than hide it
  }
}

export function LegacyFundsBanner() {
  const acct = usePredictAccountV2();
  const owner = acct.owner ?? null;
  const legacy = useLegacyFunds(owner);
  const sym = predictV2Config.quote.symbol;

  const [phase, setPhase] = useState<Phase>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Read once into state rather than on every render, so the value is stable across the
  // move and the banner cannot vanish mid-flow.
  const [dismissed, setDismissed] = useState(() => readDismissed(owner));

  const amount = legacy.balanceBase;
  const hasFunds = amount >= MIN_RECLAIM_BASE && !!legacy.wrapperId && !!legacy.deployment;

  // Stay mounted through the flow so the trader sees it finish; otherwise hide entirely.
  if (!owner || (!hasFunds && phase === 'idle') || (dismissed && phase === 'idle')) return null;

  function dismiss() {
    if (phase === 'moving') return;
    try {
      if (owner) localStorage.setItem(dismissKey(owner), '1');
    } catch {
      /* storage blocked — dismissing for this session only is fine */
    }
    setDismissed(true);
  }

  async function move() {
    if (!owner || !legacy.wrapperId || !legacy.deployment) return;
    setErrMsg(null);
    setPhase('moving');

    // 1) Out of the old account and into the wallet. First, so a later failure leaves the
    //    money somewhere the trader controls outright.
    const withdrew = await acct.runTx(
      'legacy-withdraw',
      buildLegacyWithdrawTx(legacy.wrapperId, amount, owner, legacy.deployment),
      [qkLegacyFunds(owner, legacy.deployment)],
    );
    if (!withdrew) {
      setErrMsg(`We couldn't move your ${sym} just now. Nothing was taken from the old account.`);
      setPhase('error');
      return;
    }

    // 2) Make sure there is somewhere to put it.
    if (!acct.wrapperExists) {
      const created = await acct.createAccount();
      if (!created) {
        // The money is in their wallet, which is the important part. Say so plainly rather
        // than reporting a failure that sounds like it was lost.
        setErrMsg(`Your ${sym} is in your wallet. Create your trading account to finish.`);
        setPhase('error');
        legacy.refetch();
        return;
      }
    }

    // 3) Deposit. Best-effort: if it does not land, the first trade auto-deposits anyway.
    await acct.deposit(amount);
    legacy.refetch();
    setPhase('done');
  }

  const moving = phase === 'moving';
  const label = `${fmtQuote(fromQuote(amount))} ${sym}`;

  return (
    <div className="glass-inset mb-4 flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
          <LuArrowRightLeft size={13} className="text-accent" />
        </span>
        <p className="text-[11.5px] leading-relaxed text-text-2">
          {phase === 'done' ? (
            <>
              <span className="font-medium text-text-1">Done.</span> Your {sym} has been moved to
              your new trading account.
            </>
          ) : phase === 'error' ? (
            <span className="text-text-1">{errMsg}</span>
          ) : (
            <>
              <span className="font-medium text-text-1">
                Predict moved to a new version, and you have {label} in your old account.
              </span>{' '}
              Your funds are safe. Move them across and you can trade with them again.
            </>
          )}
        </p>
      </div>

      {phase !== 'done' && (
        <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
          <button
            onClick={dismiss}
            disabled={moving}
            className="rounded-lg px-3 py-1.5 text-[11.5px] text-text-3 transition-colors hover:bg-white/[0.05] hover:text-text-1 disabled:opacity-50"
          >
            Later
          </button>
          <button
            onClick={move}
            disabled={moving}
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3.5 py-1.5 text-[11.5px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {moving ? 'Moving…' : phase === 'error' ? 'Try again' : 'Move my funds'}
          </button>
        </div>
      )}
    </div>
  );
}
