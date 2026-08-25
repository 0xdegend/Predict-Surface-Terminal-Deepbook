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
import { type FundingMode, type Limits, ModeTab, type Rules } from './shared';
import { PlanLine } from './setup';

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
  fundingMode,
  onSetFunding,
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
  fundingMode: FundingMode;
  onSetFunding: (m: FundingMode) => void;
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
  // Reusing the account balance with a session already live needs no signature at all.
  const noSignature = !live || (sessionReady && fundingMode === 'existing');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start Autopilot"
      subtitle="Check the plan, pick how it runs, then confirm."
      variant="glass"
      maxWidthClass="max-w-lg"
      contentClassName="px-5 pb-5"
      mascot={arming ? 'confident' : 'thinking'}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="glass-inset flex-none px-3.5 py-2 text-[12px] font-medium text-text-2 transition-colors hover:text-text-1"
          >
            Cancel
          </button>
          <div className="flex-1">
            <ReviewButton tone="up" onClick={onConfirm} disabled={!canConfirm || arming}>
              {arming
                ? noSignature
                  ? 'Starting…'
                  : 'Approve in wallet…'
                : live
                  ? 'Start trading'
                  : 'Start watching'}
            </ReviewButton>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <PlanLine rules={rules} limits={limits} live={live} presetId={presetId} avatar={false} />

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
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">Fund it with</span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                <FundingOption
                  active={fundingMode === 'deposit'}
                  onClick={() => onSetFunding('deposit')}
                  title={`Deposit $${num(limits.budgetUsd, 0)}`}
                  desc="One signature moves your budget into the account. The session can never spend past it."
                />
                <FundingOption
                  active={fundingMode === 'existing'}
                  onClick={() => onSetFunding('existing')}
                  title="Use account balance"
                  desc={sessionReady ? 'Trade from what you already have. No signature needed.' : 'Trade from your existing account balance.'}
                />
              </div>
            </div>

            {sessionReady && <SessionStatusRow expiresInMs={sessionExpiresInMs} onEndSession={onEndSession} />}

            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-text-3">
              <LuShieldCheck size={13} className="mt-px flex-none" />
              <span>
                {noSignature
                  ? 'Instant trading is already on, so this starts with no signature. '
                  : 'You\u2019ll approve one signature to turn on your session key. After that Kelly places bets with no wallet pop-ups until you stop. '}
                The key can only spend your trading-account balance, it can&rsquo;t withdraw or move money out, and you
                can stop the run at any moment.
              </span>
            </p>
          </>
        ) : (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-text-3">
            <LuShieldCheck size={13} className="mt-px flex-none" />
            <span>
              Kelly runs the full live logic and records every trade she would place, without spending anything and
              without a wallet signature. A rehearsal you can watch before turning on real trades.
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
            End your session and send any leftover gas back to your wallet. Your trading balance stays in your account for
            next time, and one-tap trading turns off here and across the app. You can start a fresh session whenever.
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

function FundingOption({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-all duration-150 ${
        active ? 'border-(--accent-line) bg-(--accent-soft)' : 'glass-inset border-transparent hover:border-white/10'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-1">
        <span
          className={`inline-block h-3 w-3 flex-none rounded-full border ${
            active ? 'border-accent bg-accent' : 'border-white/25'
          }`}
        />
        {title}
      </span>
      <span className="pl-4.5 text-[10.5px] leading-relaxed text-text-3">{desc}</span>
    </button>
  );
}
