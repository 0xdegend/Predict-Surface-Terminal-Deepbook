'use client';

/**
 * The arm-time confirm: the last screen before a run starts, and the only place the
 * run's mode and funding are chosen.
 *
 * Split out of autopilot-panel.tsx.
 */
import { useState } from 'react';
import { LuEye, LuPower, LuRadioTower, LuShieldCheck, LuTriangleAlert } from 'react-icons/lu';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { Modal } from '@/app/_components/ui/modal';
import { num } from '@/lib/format';
import type { PresetId } from '@/lib/autopilot/presets';
import { type Limits, ModeTab, type Rules } from './shared';
import { PlanCard } from './plan-card';

function hoursMins(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * ArmConfirmModal — the last screen before a run starts, and the only place the run's
 * mode is chosen.
 *
 * Three things used to sit on the setup screen with no business being there: the
 * watch-vs-live toggle, the "fund it with" choice, and the paragraph explaining what
 * you are signing. None of them is a setup decision. All three are questions about the
 * moment you press Start, and asking them up front meant a first-time trader had to
 * understand session keys and on-chain ceilings before they had even picked a style.
 *
 * They live here instead, next to the plan they apply to, read at the moment they
 * decide something. Watch mode asks nothing further, because it spends nothing: the
 * funding and signature half of the dialog only appears once you choose to go live.
 */
export function ArmConfirmModal({
  open,
  onClose,
  rules,
  limits,
  presetId,
  live,
  onSetLive,
  balanceUsd,
  topUpUsd,
  sessionReady,
  sessionExpiresInMs,
  onEndSession,
  issue,
  canConfirm,
  arming,
  onConfirm,
  error,
}: {
  open: boolean;
  onClose: () => void;
  rules: Rules;
  limits: Limits;
  presetId: PresetId | null;
  live: boolean;
  onSetLive: (on: boolean) => void;
  /** What is already in the trading account (DUSDC). */
  balanceUsd: number;
  /** What has to move in from the wallet before the run can cover its budget, or 0 when
   *  the account already covers it. The panel does the arithmetic; this only reads it. */
  topUpUsd: number;
  sessionReady: boolean;
  sessionExpiresInMs: number | null;
  onEndSession: () => Promise<void>;
  /** Why this run can't start as configured, if it can't. */
  issue: string | null;
  canConfirm: boolean;
  arming: boolean;
  onConfirm: () => void;
  error: string | null;
}) {
  // A funded account with a session already live needs no signature at all.
  const topUp = topUpUsd > 0;
  const noSignature = !live || (sessionReady && !topUp);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start Autopilot"
      variant="glass"
      maxWidthClass="max-w-lg"
      contentClassName="px-5 pb-5"
      mascot={arming ? 'confident' : 'thinking'}
      footer={
        <div className="flex items-center gap-2">
          {/* Cancel sets the shape here and Start matches it (`size="sm"`), not the other
              way round: a modal footer wants two of the same control in two colours, and
              the ticket's full-width `lg` next to a quiet 12px button read as two
              different kinds of thing. The `flex-1` wrapper that used to hold ReviewButton
              is gone; the modal footer is `justify-end`, so it never had free space to
              claim and the button was content-sized either way. */}
          <button
            type="button"
            onClick={onClose}
            className="glass-inset flex-none px-3.5 py-2 text-[12px] font-medium text-text-2 transition-colors hover:text-text-1"
          >
            Cancel
          </button>
          <ReviewButton tone="up" size="sm" onClick={onConfirm} disabled={!canConfirm || arming}>
            {arming
              ? noSignature
                ? 'Starting…'
                : 'Approve in wallet…'
              : live
                ? 'Start trading'
                : 'Start watching'}
          </ReviewButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <PlanCard rules={rules} limits={limits} live={null} presetId={presetId} avatar={false} variant="compact" />

        <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-white/4 p-1">
          <ModeTab
            active={!live}
            icon={LuEye}
            label="Watch first"
            sub="Spends nothing"
            onClick={() => onSetLive(false)}
          />
          <ModeTab
            active={live}
            icon={LuRadioTower}
            label="Trade live"
            sub="Real DUSDC"
            onClick={() => onSetLive(true)}
            tone="up"
          />
        </div>

        {live ? (
          <>
            {/* Was a "Fund it with" pair of radio buttons: deposit the budget, or use the
                account balance. Two clicks for a question with one right answer, asked of
                someone who is one tap from spending money. The balance decides it, so the
                balance is what gets shown. */}
            <div className="glass-inset flex items-center justify-between gap-3 rounded-lg p-3">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-text-1">Trading account</p>
                {/* Naming both amounts reads as a stutter when they are the same number
                    ("$25.00 moves in from your wallet to cover the $25"), which is the
                    common case: an empty account. The budget is worth saying once, since
                    the plan sentence above states the per-bet size but never the total. */}
                <p className="mt-0.5 text-[11px] leading-relaxed text-text-3">
                  {!topUp
                    ? `Covers the $${num(limits.budgetUsd, 0)} budget, so nothing moves in.`
                    : balanceUsd > 0
                      ? `$${num(topUpUsd, 2)} more moves in to reach the $${num(limits.budgetUsd, 0)} budget.`
                      : `Your $${num(limits.budgetUsd, 0)} budget moves in from your wallet.`}
                </p>
              </div>
              <span className="flex-none font-mono text-[15px] tabular-nums text-text-1">
                ${num(balanceUsd, 2)}
              </span>
            </div>

            {sessionReady && <SessionStatusRow expiresInMs={sessionExpiresInMs} onEndSession={onEndSession} />}

            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-text-3">
              <LuShieldCheck size={13} className="mt-px flex-none" />
              <span>
                {noSignature
                  ? 'Instant trading is already on, so this starts with no signature. '
                  : topUp
                    ? 'One signature moves the money in and turns on instant trading, then Kelly places bets with no wallet pop-ups. '
                    : 'One signature turns on instant trading, then Kelly places bets with no wallet pop-ups. '}
                It can only spend your trading-account balance, never withdraw, and you can stop any time.
              </span>
            </p>
          </>
        ) : (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-text-3">
            <LuShieldCheck size={13} className="mt-px flex-none" />
            <span>
              Kelly runs the real logic and records every trade she would place. Nothing is spent, and there is no
              signature.
            </span>
          </p>
        )}

        {issue && (
          <p className="flex items-start gap-1.5 rounded-lg border border-down/40 bg-down/10 p-2.5 text-[11.5px] leading-relaxed text-down">
            <LuTriangleAlert size={13} className="mt-px flex-none" />
            {issue}
          </p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-down/40 bg-down/10 p-2.5 text-[11.5px] leading-relaxed text-down">
            <LuTriangleAlert size={13} className="mt-px flex-none" />
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * The "instant trading is on" status, with a way to fully END the session. Ending sweeps
 * the session key's leftover SUI gas back to the wallet (so it can fund the next one) and
 * turns off one-tap trading everywhere, since the app and Autopilot share one session key.
 * Left-over DUSDC budget stays in the trading account. Guarded by an inline confirm because
 * it costs a signature and affects the whole app.
 */
function SessionStatusRow({
  expiresInMs,
  onEndSession,
}: {
  expiresInMs: number | null;
  onEndSession: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [ending, setEnding] = useState(false);

  async function end() {
    setEnding(true);
    try {
      await onEndSession();
    } finally {
      setEnding(false);
      setConfirm(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <LuShieldCheck size={13} className="flex-none text-up" />
        <span className="text-[12px] text-text-2">
          Instant trading is on{expiresInMs != null ? `, expires in ${hoursMins(expiresInMs)}` : ''}.
        </span>
        {!confirm && (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-3 transition-colors hover:text-down"
          >
            <LuPower size={11} /> End session
          </button>
        )}
      </div>

      {confirm && (
        <div className="flex flex-col gap-2 rounded-lg border border-down/30 bg-down/10 p-2.5">
          <p className="text-[11.5px] leading-relaxed text-text-2">
            Leftover gas goes back to your wallet and one-tap trading turns off across the app. Your trading balance
            stays put, and you can start a fresh session any time.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={end}
              disabled={ending}
              className="inline-flex items-center gap-1.5 rounded-md border border-down/40 bg-down/15 px-3 py-1.5 text-[11.5px] font-semibold text-down transition-colors hover:bg-down/25 disabled:opacity-50"
            >
              {ending ? 'Ending…' : 'End session and return gas'}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              disabled={ending}
              className="rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-text-3 transition-colors hover:text-text-1 disabled:opacity-50"
            >
              Keep it on
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
