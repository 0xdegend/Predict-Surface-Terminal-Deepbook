'use client';

import { Modal } from '@/app/_components/ui/modal';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import { toFloat } from '@/config/scale';
import { positionMetrics } from './position-metrics';
import type { PositionSummary } from '@/lib/api/types';

/**
 * Redeem confirmation. Shows what closing the position is worth right now (the
 * server mark — the chain confirms the exact amount on sign) and the resulting
 * PnL, so the user closes deliberately rather than from a cramped one-liner.
 */
export function RedeemModal({
  position,
  busy,
  onConfirm,
  onClose,
}: {
  position: PositionSummary | null;
  busy: boolean;
  onConfirm: (p: PositionSummary) => void;
  onClose: () => void;
}) {
  const p = position;
  const m = p ? positionMetrics(p) : null;
  const proceedsLabel = m?.isSettled ? 'Settlement payout' : 'Proceeds (sell now)';

  return (
    <Modal
      open={!!p}
      onClose={onClose}
      title={m?.isSettled ? 'Redeem settled position' : 'Close position'}
      subtitle={
        p ? `${p.is_up ? 'UP' : 'DOWN'} · ${p.underlying_asset} ${price(toFloat(p.strike))}` : undefined
      }
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded border border-line px-3 py-1.5 text-[12px] text-text-2 hover:text-text-1"
          >
            Cancel
          </button>
          <button
            onClick={() => p && onConfirm(p)}
            disabled={busy}
            className="rounded border border-line-strong bg-up/10 px-3 py-1.5 text-[12px] font-medium text-up hover:bg-up/20 disabled:opacity-50"
          >
            {busy ? 'redeeming…' : 'Confirm redeem'}
          </button>
        </>
      }
    >
      {p && m && (
        <div className="flex flex-col gap-3 font-mono text-[12px] tabular-nums">
          <p className="font-sans text-[11px] leading-relaxed text-text-3">
            {m.isSettled
              ? 'This market has settled — redeeming pays out the final result.'
              : 'Selling back before expiry returns the position’s current value. The exact amount is confirmed on-chain when you sign.'}
          </p>
          <div className="rounded border border-line-soft bg-bg-2 p-3">
            <Row label="Contracts">{fmtQuote(m.contracts)}</Row>
            <Row label="Entry cost">{fmtQuote(m.cost)}</Row>
            <Row label={proceedsLabel}>
              <span className="text-text-1">{m.value != null ? fmtQuote(m.value) : '—'}</span>
            </Row>
            <div className="my-1 border-t border-line-soft" />
            <Row label="PnL">
              <span className={m.pnl >= 0 ? 'text-up' : 'text-down'}>
                {signed(m.pnl)}
                <span className="ml-1.5 text-[10px] text-text-3">({signed(m.pnlPct * 100, 1)}%)</span>
              </span>
            </Row>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-text-3">{label}</span>
      <span className="text-text-1">{children}</span>
    </div>
  );
}
