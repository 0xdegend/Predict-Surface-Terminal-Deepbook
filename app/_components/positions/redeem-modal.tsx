'use client';

import { Modal } from '@/app/_components/ui/modal';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import { toFloat } from '@/config/scale';
import { positionMetrics } from './position-metrics';
import type { PositionSummary } from '@/lib/api/types';

/**
 * Redeem confirmation. Frosted-glass dialog leading with the resulting PnL (the
 * decision that matters), then the cost/payout breakdown. Values are the server
 * mark; the chain confirms the exact amount on sign.
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
  const up = (m?.pnl ?? 0) >= 0;
  const toneVar = up ? 'var(--up)' : 'var(--down)';

  return (
    <Modal
      open={!!p}
      onClose={onClose}
      variant="glass"
      title={m?.isSettled ? 'Redeem settled position' : 'Close position'}
      subtitle={
        p ? `${p.is_up ? 'UP' : 'DOWN'} · ${p.underlying_asset} ${price(toFloat(p.strike))}` : undefined
      }
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/[0.05] hover:text-text-1"
          >
            Cancel
          </button>
          <button
            onClick={() => p && onConfirm(p)}
            disabled={busy}
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy ? 'redeeming…' : 'Confirm redeem'}
          </button>
        </>
      }
    >
      {p && m && (
        <div className="flex flex-col gap-4">
          <p className="text-[12px] leading-relaxed text-text-3">
            {m.isSettled
              ? 'This market has settled — redeeming pays out the final result.'
              : 'Selling back before expiry returns the position’s current value. The exact amount is confirmed on-chain when you sign.'}
          </p>

          <div className="glass-inset relative overflow-hidden p-4">
            {/* faint directional wash — green on profit, coral on loss */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: `radial-gradient(120% 100% at 100% 0%, color-mix(in srgb, ${toneVar} 12%, transparent), transparent 60%)`,
              }}
            />

            {/* PnL hero */}
            <div className="relative flex items-end justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">Profit / Loss</span>
                <div className="flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-[30px] leading-none" style={{ color: toneVar }}>
                    {signed(m.pnl)}
                  </span>
                  <span className="text-[13px] leading-none" style={{ color: toneVar }}>
                    {signed(m.pnlPct * 100, 1)}%
                  </span>
                </div>
              </div>
              <span
                className="rounded-full px-2 py-1 text-[9px] font-medium uppercase tracking-wider"
                style={{ color: toneVar, background: `color-mix(in srgb, ${toneVar} 14%, transparent)` }}
              >
                {m.isSettled ? 'Settled' : 'Live mark'}
              </span>
            </div>

            <div className="hairline-fade relative my-3.5" />

            {/* Breakdown */}
            <div className="relative flex flex-col gap-2 font-mono text-[12px] tabular-nums">
              <Row label="Contracts">{fmtQuote(m.contracts)}</Row>
              <Row label="Entry cost">{fmtQuote(m.cost)}</Row>
              <Row label={proceedsLabel}>
                <span className="text-text-1">{m.value != null ? fmtQuote(m.value) : '—'}</span>
              </Row>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-3">{label}</span>
      <span className="text-text-1">{children}</span>
    </div>
  );
}
