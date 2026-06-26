'use client';

/**
 * WithdrawModal — confirmation before moving the manager's full free balance
 * back to the connected wallet. Frosted-glass dialog matching the redeem flow:
 * leads with the amount that will move, shows the destination wallet, then a
 * Cancel / Confirm footer. Presentation-only — the caller owns the withdrawal
 * and pops the SuccessModal once the tx lands.
 */
import { Modal } from '@/app/_components/ui/modal';
import { quote as fmtQuote } from '@/lib/format';
import { shortId } from '@/lib/format';
import { predictConfig } from '@/config/predict';

export function WithdrawModal({
  open,
  amount,
  address,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Free balance to withdraw, in human units. */
  amount: number;
  /** Destination wallet address (the connected owner). */
  address: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="glass"
      maxWidthClass="max-w-sm"
      title="Withdraw balance"
      subtitle="Move funds back to your wallet"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/[0.05] hover:text-text-1 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || amount <= 0}
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy ? 'Withdrawing…' : 'Confirm withdraw'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12px] leading-relaxed text-text-3">
          This sends your entire trading account balance back to your connected wallet. Open
          positions are unaffected — only uncommitted funds move.
        </p>

        <div className="glass-inset relative overflow-hidden p-4">
          {/* faint accent wash from the top-right */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: 'radial-gradient(120% 100% at 100% 0%, var(--accent-soft), transparent 60%)',
            }}
          />

          <div className="relative flex flex-col gap-1.5">
            <span className="eyebrow">Withdrawing</span>
            <span className="flex items-baseline gap-1.5 font-mono tabular-nums">
              <span className="text-[30px] leading-none text-text-1">{fmtQuote(amount)}</span>
              <span className="text-[13px] text-text-3">{predictConfig.quote.symbol}</span>
            </span>
          </div>

          <div className="hairline-fade relative my-3.5" />

          <div className="relative flex items-center justify-between font-mono text-[12px] tabular-nums">
            <span className="text-text-3">To wallet</span>
            <span className="text-text-1">{address ? shortId(address, 6, 6) : '—'}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
