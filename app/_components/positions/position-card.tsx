'use client';

import { quote as fmtQuote, price, pct, signed, dateUTC, countdown } from '@/lib/format';
import { toFloat } from '@/config/scale';
import { positionMetrics, statusLabel } from './position-metrics';
import type { PositionSummary } from '@/lib/api/types';

/**
 * A single position rendered as a clear, scannable card: side + strike + status,
 * the key economics in a 2-col grid, and a prominent colored PnL with a Redeem
 * action. Used on the Portfolio page.
 */
export function PositionCard({
  position,
  now,
  onRedeem,
  busy,
}: {
  position: PositionSummary;
  now: number;
  onRedeem: (p: PositionSummary) => void;
  busy: boolean;
}) {
  const p = position;
  const m = positionMetrics(p);
  const up = p.is_up;
  const expired = p.expiry - now <= 0;
  const status = statusLabel(p.status);

  return (
    <div
      className={`card interactive flex flex-col gap-3 p-4 pl-5 font-mono text-[12px] tabular-nums ${
        up ? 'accent-up' : 'accent-down'
      }`}
    >
      {/* header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                up ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
              }`}
            >
              {up ? 'UP' : 'DOWN'}
            </span>
            <span className="text-[13px] text-text-1">{price(toFloat(p.strike))}</span>
            <span className="font-sans text-[10px] text-text-3">settles {up ? 'above' : 'below'}</span>
          </div>
          <span className="text-[10px] text-text-3">
            {p.underlying_asset} · {dateUTC(p.expiry)} ·{' '}
            <span className={expired ? 'text-text-3' : 'text-text-2'}>
              {expired ? 'expired' : `${countdown(p.expiry, now)} left`}
            </span>
          </span>
        </div>
        <StatusChip status={status} />
      </div>

      {/* economics */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        <Stat label="Contracts" value={fmtQuote(m.contracts)} />
        <Stat label="Current value" value={m.value != null ? fmtQuote(m.value) : '—'} />
        <Stat label="Entry price" value={pct(m.entryPrice, 1)} />
        <Stat label="Mark price" value={m.markPrice != null ? pct(m.markPrice, 1) : '—'} />
        <Stat label="Cost" value={fmtQuote(m.cost)} />
        <Stat label="Max payout" value={fmtQuote(m.maxPayout)} />
      </div>

      {/* pnl + action */}
      <div className="flex items-center justify-between border-t border-line-soft pt-3">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-text-3">Unrealized PnL</span>
          <span className={`text-[15px] ${m.pnl >= 0 ? 'text-up' : 'text-down'}`}>
            {signed(m.pnl)}
            <span className="ml-2 text-[11px] text-text-3">{signed(m.pnlPct * 100, 1)}%</span>
          </span>
        </div>
        <button
          onClick={() => onRedeem(p)}
          disabled={busy}
          className="rounded border border-line-strong px-3 py-1.5 text-text-1 hover:bg-white/5 disabled:opacity-50"
        >
          {m.isSettled ? 'Redeem' : 'Close'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
      <span className="text-text-1">{value}</span>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'open'
      ? 'text-up'
      : status === 'settled'
        ? 'text-text-1'
        : status === 'awaiting settlement'
          ? 'text-down'
          : 'text-text-3';
  return (
    <span className={`text-[10px] uppercase tracking-wider ${tone}`}>{status}</span>
  );
}
