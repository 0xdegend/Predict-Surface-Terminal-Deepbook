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
 * The button is ONE transaction, and one signature. Withdrawing from the old account,
 * creating the new one when there isn't one yet, and depositing all ride in a single PTB
 * (see buildLegacyMoveTx). That is not just fewer prompts: it is atomic, so there is no
 * in-between state where the money has left the old account but has not arrived, and no
 * half-finished move to explain to someone whose balance is briefly nowhere.
 */
import { useState } from 'react';
import { LuArrowRightLeft } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useLegacyFunds, qkLegacyFunds } from '@/lib/hooks/use-legacy-funds';
import { buildLegacyMoveTx } from '@/lib/sui/v2/legacy-account';
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

/**
 * Dismissals are per wallet AND per move: "later" should mean later, not until reload, but
 * it must not mean forever.
 *
 * The key carries which release the funds are being moved FROM. Without that, someone who
 * dismissed the 7-29 banner while the app ran on 8-06 would never be shown the 8-06 one
 * after the cutover — a second, larger pile of their own money, silently suppressed by a
 * click they made about something else. Every redeploy is a new question to ask.
 */
const dismissKey = (owner: string, from: string) =>
  `skew.legacy-funds.dismissed.${from}.${owner.toLowerCase()}`;

function readDismissed(owner: string | null, from: string | null): boolean {
  if (!owner || !from) return false;
  try {
    return localStorage.getItem(dismissKey(owner, from)) === '1';
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
  const [dismissed, setDismissed] = useState(() => readDismissed(owner, legacy.deployment));

  const amount = legacy.balanceBase;
  const hasFunds = amount >= MIN_RECLAIM_BASE && !!legacy.wrapperId && !!legacy.deployment;

  // Stay mounted through the flow so the trader sees it finish; otherwise hide entirely.
  if (!owner || (!hasFunds && phase === 'idle') || (dismissed && phase === 'idle')) return null;

  function dismiss() {
    if (phase === 'moving') return;
    try {
      if (owner && legacy.deployment) localStorage.setItem(dismissKey(owner, legacy.deployment), '1');
    } catch {
      /* storage blocked — dismissing for this session only is fine */
    }
    setDismissed(true);
  }

  async function move() {
    if (!owner || !legacy.wrapperId || !legacy.deployment) return;
    // Only act on a wrapper state we actually READ. `wrapperExists` defaults to false, so
    // acting while the read is still in flight could ask the chain to create an account
    // that already exists — which aborts the whole move.
    if (!acct.wrapperKnown) return;
    // If the read says an account exists it must also have told us which one. Bailing is
    // better than depositing into a guessed address.
    if (acct.wrapperExists && !acct.wrapperId) return;
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
      return;
    }
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
              Your funds are safe. Moving them sets up your new trading account at the same
              time, in one step.
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
