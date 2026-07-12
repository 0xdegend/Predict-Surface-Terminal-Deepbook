'use client';

import { useState } from 'react';
import { Modal } from '@/app/_components/ui/modal';
import { quote as fmtQuote, price, signed, shortId } from '@/lib/format';
import { fromQuote } from '@/config/scale';
import { CloseAmountPicker } from '@/app/_components/positions/close-amount-picker';
import { POSITION_LOT_BASE } from '@/lib/sui/v2/quote';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';

/**
 * V2RedeemModal — the NEW deployment's close/redeem confirmation, at full parity
 * with the legacy RedeemModal (positions/redeem-modal.tsx). Frosted-glass dialog
 * leading with the resulting PnL (the decision that matters), then the
 * cost/payout breakdown. The trader picks how much of the lot to close — 25 / 50
 * / 75 / Max, or an exact contract count (the shared CloseAmountPicker, so the
 * two flows can never drift) — and every figure scales to that amount. On confirm
 * we pass the chosen on-chain base quantity; the chain confirms the exact amount
 * on sign. Closing < 100% leaves the remainder open to close later.
 *
 * Reads the enriched V2PortfolioPosition (already de-scaled to floats + base
 * units) rather than a raw indexer row, so no positionMetrics indirection.
 */
export function V2RedeemModal({
  position,
  busy,
  onConfirm,
  onClose,
}: {
  position: V2PortfolioPosition | null;
  busy: boolean;
  // closeQuantity is on-chain base units (@6dec); equal-to-open ⇒ full close.
  onConfirm: (p: V2PortfolioPosition, closeQuantity: bigint) => void;
  onClose: () => void;
}) {
  const p = position;
  const isRange = p?.direction === 'Range';
  const up = p ? p.direction !== 'Down' : true;

  // Full open lot in base units (@6dec) — the redeemable ceiling.
  const openBase = p?.qtyBase ?? 0n;
  // Identity of the lot in view; resets the selector when a new card is opened.
  const lotId = p?.key ?? null;

  // Chosen close amount, in base units. Defaults to the full lot, and resets to
  // full whenever a different lot is opened — the React "adjust state during
  // render" pattern (no effect, no cascading render), matching the legacy modal.
  const [closeBase, setCloseBase] = useState<bigint>(openBase);
  const [seenLotId, setSeenLotId] = useState<string | null>(lotId);
  if (lotId !== seenLotId) {
    setSeenLotId(lotId);
    setCloseBase(openBase);
  }

  // Fraction of the lot being closed (0..1) — scales the linear breakdown.
  const fraction = openBase > 0n ? Number(closeBase) / Number(openBase) : 0;

  const settled = !!p?.settled;
  const pnl = p?.pnl ?? 0;
  const cost = p?.cost ?? 0;
  const value = p?.markValue ?? null;
  const pnlPct = cost > 0 ? pnl / cost : 0;
  const contracts = p?.qty ?? 0;

  // Settled against the bet → paid nothing. Frame as clearing a worthless
  // position rather than "redeeming" a payout that isn't there.
  const worthless = settled && (p?.won === false || (value != null && value <= 0));
  const proceedsLabel = worthless ? 'Payout' : settled ? 'Settlement payout' : 'Proceeds (sell now)';
  const partial = closeBase > 0n && closeBase < openBase;
  const gain = pnl >= 0;
  const toneVar = gain ? 'var(--up)' : 'var(--down)';
  const canConfirm = !!p && !p.sample && !!p.marketId && p.orderId != null && closeBase > 0n;

  // Linear scaling of the lot's marks to the chosen amount.
  const closeContracts = fromQuote(closeBase);
  const remainContracts = contracts - closeContracts;
  const closeCost = cost * fraction;
  const closeValue = value != null ? value * fraction : null;
  const closePnl = pnl * fraction;

  const title = p?.underlying ?? (p?.marketId ? shortId(p.marketId) : 'Position');
  const subtitle = p
    ? isRange && p.band != null
      ? `Range · ${title} ${price(p.band.lower)}–${price(p.band.higher)}`
      : `${up ? 'UP' : 'DOWN'} · ${title}${p.strike != null ? ` ${price(p.strike)}` : ''}`
    : undefined;

  const dialogTitle = worthless
    ? 'Clear settled position'
    : settled
      ? isRange
        ? 'Redeem settled range'
        : 'Redeem settled position'
      : isRange
        ? 'Close range'
        : 'Close position';

  return (
    <Modal
      open={!!p}
      onClose={onClose}
      variant="glass"
      title={dialogTitle}
      subtitle={subtitle}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/[0.05] hover:text-text-1"
          >
            Cancel
          </button>
          <button
            onClick={() => p && canConfirm && onConfirm(p, settled ? openBase : closeBase)}
            disabled={busy || !canConfirm}
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy
              ? worthless
                ? 'clearing…'
                : settled
                  ? 'redeeming…'
                  : 'closing…'
              : worthless
                ? 'Clear position'
                : settled
                  ? partial
                    ? 'Redeem portion'
                    : isRange
                      ? 'Redeem range'
                      : 'Confirm redeem'
                  : partial
                    ? 'Close portion'
                    : isRange
                      ? 'Close full range'
                      : 'Close full position'}
          </button>
        </>
      }
    >
      {p && (
        <div className="flex flex-col gap-4">
          <p className="text-[12px] leading-relaxed text-text-3">
            {worthless
              ? 'This market settled against your bet, so it paid nothing. Clearing just removes the worthless position from your account.'
              : settled
                ? 'This market has settled — the payout is claimed in full (a settled position can’t be claimed in parts).'
                : 'Closing returns the position’s current value. Close all of it, or part of it and leave the rest open to close later. The exact amount is confirmed on-chain when you sign.'}
          </p>

          {/* Partial amounts are only valid while the market is LIVE. The contract
              requires a settled position to be redeemed in full — redeem_settled
              asserts close_quantity == the order's full quantity (EFullCloseRequired)
              — so the picker only shows for a live close; settled claims go full. */}
          {!settled && (
            <CloseAmountPicker openBase={openBase} closeBase={closeBase} onChange={setCloseBase} lotBase={POSITION_LOT_BASE} />
          )}

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
                {settled ? 'Settled' : 'Live mark'}
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
