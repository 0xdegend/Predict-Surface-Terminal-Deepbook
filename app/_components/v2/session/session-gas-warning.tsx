'use client';

/**
 * SessionGasWarning — an in-ticket heads-up when instant trading is LIVE but its
 * session key is running low on gas (SUI).
 *
 * The session key pays each instant trade's network fee out of its own SUI. When that
 * balance drops below one trade's budget, a trade silently falls back to the OWNER path
 * — i.e. a wallet pop-up (see `sessionCanTrade` in use-predict-account-v2). A trader who
 * armed instant trading then sees a pop-up appear out of nowhere and reads it as "my
 * session stopped working". This surfaces the real reason and offers a one-tap top-up
 * right where they trade, so they refill instead of thinking it broke.
 *
 * Two states: RUNNING LOW (still enough for a trade or so — a gentle "top up soon") and
 * OUT (below one trade's budget — the pop-up is already back, so say why). Renders null
 * in every other state: no session, a comfortably-funded session, or gasless (a Google
 * session is sponsored and can't reach this state). Self-contained — it mounts its own
 * SessionGasModal. See [[sessions-delegated-trading]].
 */
import { useState } from 'react';
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { SESSION_GAS_BUDGET } from '@/lib/sui/v2/session';
import { SessionGasModal } from '@/app/_components/session-gas-modal';

// Warn once the key holds fewer than ~2 trades' worth of gas, so there's runway to top
// up BEFORE it drops below one trade's budget and the pop-up comes back.
const LOW_GAS_THRESHOLD = SESSION_GAS_BUDGET * 2n;

export function SessionGasWarning() {
  const acct = usePredictAccountV2();
  const [gasModalOpen, setGasModalOpen] = useState(false);

  // Only while a session is on (Slush + live key) and its gas is getting low.
  if (!acct.sessionActive || acct.sessionGasBase >= LOW_GAS_THRESHOLD) return null;

  // Still enough for a trade → a gentle nudge; below one trade's budget → the pop-up is
  // already back, so explain it.
  const canStillTrade = acct.sessionCanTrade;

  return (
    <>
      <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-(--warn-soft) p-2.5">
        <span aria-hidden className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-warn/15 text-warn">
          <LuZap size={12} />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-[12px] leading-relaxed text-text-1">
            {canStillTrade ? (
              <>
                Instant trading is running low on gas. Top it up so your trades keep going through
                without a wallet pop-up.
              </>
            ) : (
              <>
                Instant trading is out of gas. Your session is still on, but until you top it up your
                trades ask for a wallet approval instead of going straight through.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => setGasModalOpen(true)}
            className="w-fit rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] font-medium text-warn transition-colors hover:bg-warn/20"
          >
            Top up gas
          </button>
        </div>
      </div>
      <SessionGasModal open={gasModalOpen} onClose={() => setGasModalOpen(false)} />
    </>
  );
}
