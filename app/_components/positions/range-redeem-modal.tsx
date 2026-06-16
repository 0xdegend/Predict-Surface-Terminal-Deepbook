'use client';

import { useState } from 'react';
import { Modal } from '@/app/_components/ui/modal';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import { fromQuote, toFloat } from '@/config/scale';
import { CloseAmountPicker } from './close-amount-picker';
import type { ValuedRangePosition } from '@/lib/hooks/use-range-positions';

/**
 * Close confirmation for a vertical-range position — the range sibling of
 * RedeemModal. Leads with PnL, lets the trader close part or all of the lot
 * (presets + exact contracts), and scales every figure to the chosen amount.
 * On confirm we pass the chosen on-chain base quantity; closing < 100% leaves
 * the remainder open to close later.
 */
export function RangeRedeemModal({
  position,
  busy,
  onConfirm,
  onClose,
}: {
  position: ValuedRangePosition | null;
  busy: boolean;
  // quantityBase is on-chain base units (@6dec); equal-to-open ⇒ full close.
  onConfirm: (p: ValuedRangePosition, quantityBase: bigint) => void;
  onClose: () => void;
}) {
  const p = position;

  const openBase = p ? BigInt(Math.round(p.openQty)) : 0n;
  const lotId = p ? `${p.oracleId}-${p.lowerStrike}-${p.higherStrike}-${p.openQty}` : null;

  // Chosen close amount, in base units — resets to full when a new lot opens
  // (React "adjust state during render" pattern; no effect).
  const [closeBase, setCloseBase] = useState<bigint>(openBase);
  const [seenLotId, setSeenLotId] = useState<string | null>(lotId);
  if (lotId !== seenLotId) {
    setSeenLotId(lotId);
    setCloseBase(openBase);
  }

  const decided = !!p?.settled;
  const fraction = openBase > 0n ? Number(closeBase) / Number(openBase) : 0;
  const partial = closeBase > 0n && closeBase < openBase;
  const canConfirm = !!p && closeBase > 0n;

  // Lot marks, then linear scaling to the chosen amount.
  const contracts = p ? fromQuote(p.openQty) : 0;
  const cost = p ? fromQuote(p.openCostBasis) : 0;
  const value = p ? fromQuote(p.currentValue) : 0;
  const pnl = p ? fromQuote(p.unrealizedPnl) : 0;
  const pnlPct = p && p.openCostBasis > 0 ? p.unrealizedPnl / p.openCostBasis : 0;

  const closeContracts = fromQuote(closeBase);
  const remainContracts = contracts - closeContracts;
  const closeCost = cost * fraction;
  const closeValue = value * fraction;
  const closePnl = pnl * fraction;

  // Settled out of the band → marks to exactly 0, so it paid nothing. Frame this
  // as clearing a worthless position, not "redeeming" a payout that doesn't
  // exist. Value-based (a live lot always carries positive value) because
  // `p.settled` only flips once a redeem record exists.
  const worthless = !!p && value <= 0;
  const up = pnl >= 0;
  const toneVar = up ? 'var(--up)' : 'var(--down)';
  const proceedsLabel = worthless ? 'Payout' : decided ? 'Settlement payout' : 'Proceeds (sell now)';

  return (
    <Modal
      open={!!p}
      onClose={onClose}
      variant="glass"
      title={worthless ? 'Clear settled range' : decided ? 'Redeem settled range' : 'Close range'}
      subtitle={
        p ? `${p.underlying || 'BTC'} ${price(toFloat(p.lowerStrike))} — ${price(toFloat(p.higherStrike))}` : undefined
      }
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/5 hover:text-text-1"
          >
            Cancel
          </button>
          <button
            onClick={() => p && canConfirm && onConfirm(p, closeBase)}
            disabled={busy || !canConfirm}
            className="rounded-lg border border-(--accent-line) bg-(--accent-soft) px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy
              ? worthless
                ? 'clearing…'
                : decided
                  ? 'redeeming…'
                  : 'closing…'
              : worthless
                ? 'Clear position'
                : decided
                  ? partial
                    ? 'Redeem portion'
                    : 'Confirm redeem'
                  : partial
                    ? 'Close portion'
                    : 'Close full range'}
          </button>
        </>
      }
    >
      {p && (
        <div className="flex flex-col gap-4">
          <p className="text-[12px] leading-relaxed text-text-3">
            {worthless
              ? 'This range settled out of the band, so it paid nothing. Clearing just removes the worthless position from your account.'
              : decided
                ? 'This range has settled — redeeming pays out the final result. You can claim part now and the rest later.'
                : 'Closing returns the range’s current value. Close all of it, or part of it and leave the rest open to close later. The exact amount is confirmed on-chain when you sign.'}
          </p>

          <CloseAmountPicker openBase={openBase} closeBase={closeBase} onChange={setCloseBase} />

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
                    {signed(pnlPct * 100, 1)}%
                  </span>
                </div>
              </div>
              <span
                className="rounded-full px-2 py-1 text-[9px] font-medium uppercase tracking-wider"
                style={{ color: toneVar, background: `color-mix(in srgb, ${toneVar} 14%, transparent)` }}
              >
                {decided ? 'Settled' : 'Live mark'}
              </span>
            </div>

            <div className="hairline-fade relative my-3.5" />

            {/* Breakdown — figures reflect the chosen close amount */}
            <div className="relative flex flex-col gap-2 font-mono text-[12px] tabular-nums">
              <Row label="Contracts closing">{fmtQuote(closeContracts)}</Row>
              <Row label="Entry cost">{fmtQuote(closeCost)}</Row>
              <Row label={proceedsLabel}>
                <span className="text-text-1">{fmtQuote(closeValue)}</span>
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
