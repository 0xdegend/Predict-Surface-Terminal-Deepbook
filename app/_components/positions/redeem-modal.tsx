'use client';

import { useMemo, useState } from 'react';
import { Modal } from '@/app/_components/ui/modal';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import { fromQuote, toFloat } from '@/config/scale';
import { positionMetrics } from './position-metrics';
import type { PositionSummary } from '@/lib/api/types';

const PRESETS = [25, 50, 75, 100] as const;

/**
 * Redeem confirmation. Frosted-glass dialog leading with the resulting PnL (the
 * decision that matters), then the cost/payout breakdown. The trader picks how
 * much of the lot to close — 25 / 50 / 75 / Max, or an exact contract count —
 * and every figure (proceeds, PnL, what's left) scales to that amount. On
 * confirm we pass the chosen on-chain base quantity; the chain confirms the
 * exact amount on sign. Closing < 100% leaves the remainder open to close later.
 */
export function RedeemModal({
  position,
  busy,
  onConfirm,
  onClose,
}: {
  position: PositionSummary | null;
  busy: boolean;
  // quantityBase is on-chain base units (@6dec); omitted/equal-to-open ⇒ full close.
  onConfirm: (p: PositionSummary, quantityBase: bigint) => void;
  onClose: () => void;
}) {
  const p = position;
  const m = p ? positionMetrics(p) : null;

  // Full open lot in base units (@6dec) — the redeemable ceiling.
  const openBase = p ? BigInt(Math.round(p.open_quantity)) : 0n;
  // Identity of the lot in view; resets the selector when a new card is opened.
  const lotId = p ? `${p.oracle_id}-${p.strike}-${p.is_up}-${p.open_quantity}` : null;

  // Chosen close amount, in base units. Defaults to the full lot, and resets
  // to full whenever a different lot is opened — the React-documented
  // "adjust state during render" pattern (no effect, no cascading render).
  const [closeBase, setCloseBase] = useState<bigint>(openBase);
  const [seenLotId, setSeenLotId] = useState<string | null>(lotId);
  if (lotId !== seenLotId) {
    setSeenLotId(lotId);
    setCloseBase(openBase);
  }

  // Fraction of the lot being closed (0..1) — scales the linear breakdown.
  const fraction = openBase > 0n ? Number(closeBase) / Number(openBase) : 0;
  const activePreset = useMemo(
    () => PRESETS.find((pp) => Math.abs(fraction * 100 - pp) < 0.5) ?? null,
    [fraction],
  );

  function setPct(pct: number) {
    // 100% → exact open (no rounding dust left behind); else floor to base units.
    setCloseBase(pct >= 100 ? openBase : BigInt(Math.floor(Number(openBase) * (pct / 100))));
  }

  function setContracts(raw: string) {
    if (!p) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setCloseBase(0n);
      return;
    }
    // contracts (human) → base units, clamped to the open lot.
    const base = BigInt(Math.round(n * 1_000_000));
    setCloseBase(base > openBase ? openBase : base);
  }

  const proceedsLabel = m?.isSettled ? 'Settlement payout' : 'Proceeds (sell now)';
  const partial = closeBase > 0n && closeBase < openBase;
  const up = (m?.pnl ?? 0) >= 0;
  const toneVar = up ? 'var(--up)' : 'var(--down)';
  const canConfirm = !!p && closeBase > 0n;

  // Linear scaling of the lot's marks to the chosen amount.
  const closeContracts = fromQuote(closeBase);
  const remainContracts = m ? m.contracts - closeContracts : 0;
  const closeCost = m ? m.cost * fraction : 0;
  const closeValue = m?.value != null ? m.value * fraction : null;
  const closePnl = m ? m.pnl * fraction : 0;

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
            onClick={() => p && canConfirm && onConfirm(p, closeBase)}
            disabled={busy || !canConfirm}
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy
              ? m?.isSettled
                ? 'redeeming…'
                : 'closing…'
              : m?.isSettled
                ? partial
                  ? 'Redeem portion'
                  : 'Confirm redeem'
                : partial
                  ? 'Close portion'
                  : 'Close full position'}
          </button>
        </>
      }
    >
      {p && m && (
        <div className="flex flex-col gap-4">
          <p className="text-[12px] leading-relaxed text-text-3">
            {m.isSettled
              ? 'This market has settled — redeeming pays out the final result. You can claim part now and the rest later.'
              : 'Closing returns the position’s current value. Close all of it, or part of it and leave the rest open to close later. The exact amount is confirmed on-chain when you sign.'}
          </p>

          {/* Amount to close — preset chips + an exact contract count, kept in sync. */}
          <div className="glass-inset flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Amount to close</span>
              <span className="font-mono text-[11px] tabular-nums text-text-2">
                {(fraction * 100).toFixed(fraction === 1 || fraction === 0 ? 0 : 1)}% of lot
              </span>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {PRESETS.map((pp) => (
                <button
                  key={pp}
                  onClick={() => setPct(pp)}
                  className={`rounded-md border px-2 py-1.5 font-mono text-[11px] tabular-nums transition-colors ${
                    activePreset === pp
                      ? 'border-(--accent-line) bg-(--accent-soft) text-up'
                      : 'border-line text-text-2 hover:border-line-strong hover:text-text-1'
                  }`}
                >
                  {pp === 100 ? 'Max' : `${pp}%`}
                </button>
              ))}
            </div>

            <label className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-text-3">Contracts</span>
              <span className="flex items-baseline gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={m.contracts}
                  step="any"
                  value={closeContracts === 0 ? '' : Number(closeContracts.toFixed(6)).toString()}
                  onChange={(e) => setContracts(e.target.value)}
                  className="w-28 rounded-md border border-line bg-black/20 px-2 py-1.5 text-right font-mono text-[12px] tabular-nums text-text-1 focus:border-(--accent-line) focus:outline-none"
                />
                <span className="text-[10px] uppercase tracking-wider text-text-3">
                  / {fmtQuote(m.contracts)}
                </span>
              </span>
            </label>
          </div>

          <div className="glass-inset relative overflow-hidden p-4">
            {/* faint directional wash — green on profit, coral on loss */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: `radial-gradient(120% 100% at 100% 0%, color-mix(in srgb, ${toneVar} 12%, transparent), transparent 60%)`,
              }}
            />

            {/* PnL hero — scaled to the amount being closed */}
            <div className="relative flex items-end justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">{partial ? 'Profit / Loss on close' : 'Profit / Loss'}</span>
                <div className="flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-[30px] leading-none" style={{ color: toneVar }}>
                    {signed(closePnl)}
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

            {/* Breakdown — figures reflect the chosen close amount */}
            <div className="relative flex flex-col gap-2 font-mono text-[12px] tabular-nums">
              <Row label="Contracts closing">{fmtQuote(closeContracts)}</Row>
              <Row label="Entry cost">{fmtQuote(closeCost)}</Row>
              <Row label={proceedsLabel}>
                <span className="text-text-1">{closeValue != null ? fmtQuote(closeValue) : '—'}</span>
              </Row>
              {partial && (
                <Row label="Remaining open">
                  <span className="text-text-2">{fmtQuote(remainContracts)} contracts</span>
                </Row>
              )}
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
