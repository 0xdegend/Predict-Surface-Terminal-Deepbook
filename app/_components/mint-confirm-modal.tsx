'use client';

import { useState } from 'react';
import { LuInfo } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';

export type ConfirmRow = { label: string; value: string; emphasize?: boolean };

/**
 * MintConfirmModal — the review-and-confirm gate shown before a Google/zkLogin
 * (Enoki) user mints. Those accounts sign gaslessly with no wallet pop-up, so
 * without this step a tap on "Mint" would commit funds with nothing to confirm
 * intent. Mirrors the cash-out flow's confirm step. Normal wallets skip this —
 * their wallet prompt already serves as the review moment.
 *
 * Presentation-only: the caller owns the trade math and passes formatted rows
 * plus the cost → max-win headline.
 */
export function MintConfirmModal({
  open,
  onClose,
  onConfirm,
  busy,
  headline,
  tone,
  rows,
  cost,
  maxWin,
  confirmLabel = 'Confirm mint',
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  /** Short title for the position, e.g. "BTC · UP". */
  headline: string;
  tone: 'up' | 'down';
  rows: ConfirmRow[];
  /** Formatted total cost (what they pay now). */
  cost: string;
  /** Formatted max payout (what they win if it settles in their favor). */
  maxWin: string;
  confirmLabel?: string;
}) {
  // The fox deliberates with you (thinking), then backs your call (confident)
  // the moment you reach for the mint button — or while the mint is in flight.
  const [committing, setCommitting] = useState(false);
  const toneText = tone === 'up' ? 'text-up' : 'text-down';
  const confirmCls =
    tone === 'up'
      ? 'border-up/50 bg-up/15 text-up hover:bg-up/25'
      : 'border-down/50 bg-down/15 text-down hover:bg-down/25';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm your trade"
      subtitle="Signed in with Google — mints instantly, no wallet pop-up"
      variant="glass"
      maxWidthClass="max-w-sm"
      mascot={busy || committing ? 'confident' : 'thinking'}
      footer={
        // Full-width row so Cancel sits far-left and the commit CTA far-right —
        // keeps "back out" clearly separated from "mint" rather than clustering
        // them together (the Modal footer is justify-end; a w-full child overrides
        // that for this dialog only).
        <div className="flex w-full items-center justify-between">
          <button
            onClick={onClose}
            disabled={busy}
            className="ctrl-soft rounded-lg px-3.5 py-2 text-[12px] font-medium text-text-2 hover:text-text-1 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            onMouseEnter={() => setCommitting(true)}
            onMouseLeave={() => setCommitting(false)}
            onFocus={() => setCommitting(true)}
            onBlur={() => setCommitting(false)}
            className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${confirmCls}`}
          >
            {busy && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
            )}
            {busy ? 'Minting…' : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 font-mono tabular-nums">
        {/* Headline — what they're about to hold */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-text-3">Position</span>
          <span className={`text-[13px] font-semibold ${toneText}`}>{headline}</span>
        </div>

        {/* Trade detail rows */}
        <div className="glass-inset flex flex-col gap-px overflow-hidden rounded-lg">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between bg-bg-2/40 px-3 py-2">
              <span className="text-[11px] text-text-3">{r.label}</span>
              <span
                className={`text-[12px] ${r.emphasize ? 'font-semibold text-text-1' : 'text-text-2'}`}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>

        {/* The money line — pay now → win if it lands */}
        <div className="flex items-stretch gap-2">
          <div className="flex flex-1 flex-col gap-0.5 rounded-lg border border-line bg-bg-2/40 px-3 py-2">
            <span className="text-[10px] uppercase tracking-wider text-text-3">You pay</span>
            <span className="text-[14px] font-semibold text-text-1">{cost}</span>
          </div>
          <div className={`flex flex-1 flex-col gap-0.5 rounded-lg border px-3 py-2 ${tone === 'up' ? 'border-up/30 bg-up/5' : 'border-down/30 bg-down/5'}`}>
            <span className="text-[10px] uppercase tracking-wider text-text-3">Max win</span>
            <span className={`text-[14px] font-semibold ${toneText}`}>{maxWin}</span>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-text-3">
          <LuInfo size={12} className="mt-0.5 flex-none" />
          The chain confirms the final price when you mint — it can still revert if the market moves
          or expires first.
        </p>
      </div>
    </Modal>
  );
}
