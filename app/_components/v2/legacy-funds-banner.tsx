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
 *
 * TWO CASES, AND THE BANNER MUST NOT CONFUSE THEM. Up to 8-21 every release settled in the
 * same coin, so the balance could always be carried across and the banner only ever said
 * "Migrate". 9-12 publishes its OWN collateral: the old `dusdc::DUSDC` cannot enter the new
 * account, there is no swap, and the move would be rejected by the chain AFTER the trader
 * signed it. So when `canMove` is false this offers the only thing that actually works,
 * withdrawing the old coin to the wallet, and says plainly that it is not the coin they now
 * trade with. It names the balance in the OLD release's ticker for the same reason: calling
 * a stranded DUSDC balance "USDC" is precisely the misunderstanding worth preventing.
 */
import { useState } from 'react';
import { LuCircleFadingArrowUp } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useLegacyMove } from '@/lib/hooks/use-legacy-move';

import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';

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
  const legacy = useLegacyMove();
  const { phase, errMsg, amount, canMove, oldSym } = legacy;

  // Read once into state rather than on every render, so the value is stable across the
  // move and the banner cannot vanish mid-flow.
  const [dismissed, setDismissed] = useState(() => readDismissed(owner, legacy.deployment));

  // Stay mounted through the flow so the trader sees it finish; otherwise hide entirely.
  if (!owner || (!legacy.hasFunds && phase === 'idle') || (dismissed && phase === 'idle')) return null;

  function dismiss() {
    if (phase === 'moving') return;
    try {
      if (owner && legacy.deployment) localStorage.setItem(dismissKey(owner, legacy.deployment), '1');
    } catch {
      /* storage blocked — dismissing for this session only is fine */
    }
    setDismissed(true);
  }

  const moving = phase === 'moving';
  const label = `${fmtQuote(fromQuote(amount))} ${oldSym}`;

  return (
    <div className="glass-inset mb-4 flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
          <LuCircleFadingArrowUp size={13} className="text-accent" />
        </span>
        <p className="text-[11.5px] leading-relaxed text-text-2">
          {phase === 'done' ? (
            <>
              <span className="font-medium text-text-1">Done.</span>{' '}
              {canMove ? (
                <>You are on the new version, with your {oldSym} in your trading account.</>
              ) : (
                <>Your {oldSym} is back in your wallet.</>
              )}
            </>
          ) : phase === 'error' ? (
            <span className="text-text-1">{errMsg}</span>
          ) : (
            <>
              <span className="font-medium text-text-1">A new version of Predict.</span>{' '}
              {canMove ? (
                <>
                  Your {label} is still in your account on the previous release, and migrating
                  brings it across in the same transaction.
                </>
              ) : (
                <>
                  Your {label} is still in your account on the previous release. This release
                  settles in a different coin, so that balance cannot come across and there is no
                  swap between them. You can withdraw it back to your wallet.
                </>
              )}
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
            onClick={() => void (canMove ? legacy.move() : legacy.withdraw())}
            disabled={moving}
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3.5 py-1.5 text-[11.5px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {moving
              ? canMove
                ? 'Migrating…'
                : 'Withdrawing…'
              : phase === 'error'
                ? 'Try again'
                : canMove
                  ? 'Migrate'
                  : 'Withdraw to wallet'}
          </button>
        </div>
      )}
    </div>
  );
}
