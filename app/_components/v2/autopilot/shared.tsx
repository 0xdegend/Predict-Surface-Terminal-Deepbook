/**
 * Shared vocabulary for the Autopilot screens: the store-derived config types, the
 * setup-mode union, the two signed-number formatters, and the one control (ModeTab)
 * that both the setup fork and the arm confirm use.
 *
 * Anything here is used by MORE THAN ONE of setup / live / results. Single-area helpers
 * deliberately live with their area instead, so this file stays a genuine crossroads
 * rather than a junk drawer.
 */
import type { IconType } from 'react-icons';
import { useAutopilotStore } from '@/lib/store/autopilot-store';

/** How the trader sets Autopilot up: say it in words, or work the controls. */
export type SetupMode = 'auto' | 'manual';

export type Rules = ReturnType<typeof useAutopilotStore.getState>['rules'];

export type Limits = ReturnType<typeof useAutopilotStore.getState>['limits'];

/**
 * What happened when the trader said "start" to Kelly. The chat answers in words off
 * this, so the reply always matches what the panel actually did.
 */
export type StartOutcome =
  /** The run is armed. Nothing else to do. */
  | { kind: 'started'; live: boolean }
  /** Instant trading needs the wallet's approval first. `done` resolves true once the
   *  run is armed, false if the approval failed or was cancelled. */
  | { kind: 'signing'; done: Promise<boolean> }
  /** Money has to move in before the budget is covered: the start screen is open so the
   *  trader can see the amount and confirm it. */
  | { kind: 'confirm'; why: 'top_up'; topUpUsd: number; budgetUsd: number }
  /** A live blocker the chat cannot clear (no wallet, no trading account, sessions off):
   *  the start screen is open, where the way past it (connect, or switch to watch) lives. */
  | { kind: 'confirm'; why: 'blocked'; issue: string };

/** Signed dollar amount, cents shown (PnL is small). e.g. +$0.84, -$5.00. */
export function signedUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

/** Color class for a signed number (a small dead-band reads flat as neutral). */
export function pnlClass(v: number): string {
  return v > 0.005 ? 'text-up' : v < -0.005 ? 'text-down' : 'text-text-2';
}

export function ModeTab({
  active,
  icon: Icon,
  label,
  sub,
  onClick,
  tone,
}: {
  active: boolean;
  icon: IconType;
  label: string;
  sub: string;
  onClick: () => void;
  tone?: 'up';
}) {
  const activeCls = tone === 'up' ? 'bg-(--up-soft) text-up' : 'bg-(--accent-soft) text-text-1';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 transition-all duration-150 ${
        active ? activeCls : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={14} className="flex-none" />
      <span className="flex flex-col items-start leading-tight">
        <span className="text-[12.5px] font-medium">{label}</span>
        <span className="text-[10px] opacity-70">{sub}</span>
      </span>
    </button>
  );
}
