'use client';

import Link from 'next/link';
import { LuExternalLink, LuArrowUpRight } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';
import type { ConfirmRow } from './mint-confirm-modal';
import { predictConfig } from '@/config/predict';

/**
 * MintSuccessModal — the celebratory "your bet is in" confirmation shown after a
 * position mints. Replaces the easy-to-miss bottom-right toast for the trade
 * flow: the Skew fox peeks in to celebrate (mascot="won"), the position is
 * restated (the same rows the confirm step showed), and the stake → max-win line
 * is repeated so the trader sees exactly what they're now holding, with a direct
 * jump to their positions and an explorer link.
 *
 * Presentation-only: the caller snapshots the formatted trade details at mint
 * time and owns when to open it.
 */
export function MintSuccessModal({
  open,
  onClose,
  headline,
  tone,
  rows,
  staked,
  maxWin,
  digest,
}: {
  open: boolean;
  onClose: () => void;
  /** Short title for the position, e.g. "BTC · UP". */
  headline: string;
  tone: 'up' | 'down';
  rows: ConfirmRow[];
  /** Formatted stake (what they paid). */
  staked: string;
  /** Formatted max payout (what they win if it lands). */
  maxWin: string;
  /** Executed tx digest → renders a "View on explorer" link. */
  digest?: string;
}) {
  const toneText = tone === 'up' ? 'text-up' : 'text-down';
  const explorer = digest ? `https://suiscan.xyz/${predictConfig.network}/tx/${digest}` : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bet placed"
      subtitle="Your position is open — good luck"
      variant="glass"
      maxWidthClass="max-w-sm"
      mascot="won"
      footer={
        <div className="flex w-full items-center justify-between">
          <button
            onClick={onClose}
            className="ctrl-soft rounded-lg px-3.5 py-2 text-[12px] font-medium text-text-2 hover:text-text-1"
          >
            Done
          </button>
          <Link
            href="/portfolio"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-(--accent-line) bg-(--accent-soft) px-4 py-2 text-[12px] font-semibold text-up transition-shadow hover:shadow-[0_0_22px_-8px_var(--accent-glow)]"
          >
            View positions <LuArrowUpRight size={14} />
          </Link>
        </div>
      }
    >
      <div className="flex flex-col gap-3 font-mono tabular-nums">
        {/* Headline — what they now hold. The pill pops in to mark the win. */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-text-3">Position</span>
          <span
            className={`text-[13px] font-semibold ${toneText} motion-safe:animate-[checkPop_420ms_cubic-bezier(0.34,1.56,0.64,1)_both]`}
          >
            {headline}
          </span>
        </div>

        {/* Trade detail rows — same shape as the confirm step. */}
        <div className="glass-inset flex flex-col gap-px overflow-hidden rounded-lg">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between bg-bg-2/40 px-3 py-2">
              <span className="text-[11px] text-text-3">{r.label}</span>
              <span className={`text-[12px] ${r.emphasize ? 'font-semibold text-text-1' : 'text-text-2'}`}>
                {r.value}
              </span>
            </div>
          ))}
        </div>

        {/* The money line — paid → win if it lands. */}
        <div className="flex items-stretch gap-2">
          <div className="flex flex-1 flex-col gap-0.5 rounded-lg border border-line bg-bg-2/40 px-3 py-2">
            <span className="text-[10px] uppercase tracking-wider text-text-3">You staked</span>
            <span className="text-[14px] font-semibold text-text-1">{staked}</span>
          </div>
          <div className={`flex flex-1 flex-col gap-0.5 rounded-lg border px-3 py-2 ${tone === 'up' ? 'border-up/30 bg-up/5' : 'border-down/30 bg-down/5'}`}>
            <span className="text-[10px] uppercase tracking-wider text-text-3">Max win</span>
            <span className={`text-[14px] font-semibold ${toneText}`}>{maxWin}</span>
          </div>
        </div>

        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 self-center text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline"
          >
            View on explorer <LuExternalLink size={11} />
          </a>
        )}
      </div>
    </Modal>
  );
}
