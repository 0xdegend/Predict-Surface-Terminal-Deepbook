'use client';

/**
 * OpenPositions — the trader's currently-open binary + range positions, with
 * one-tap Close/Redeem. Lifted out of FlowPanel so it can sit BELOW the
 * Market-odds panel in the right rail (odds on top, positions at the bottom).
 *
 * Reads the SAME usePredictAccount + useRangePositions hooks the ticket uses, so
 * the figures stay in lockstep and TanStack dedupes the fetch (no second poll).
 * Capped at 3 positions TOTAL so the rail never grows long — the rest are one tap
 * away under Portfolio.
 */
import { useState } from 'react';
import Link from 'next/link';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useRangePositions, type ValuedRangePosition } from '@/lib/hooks/use-range-positions';
import { predictConfig } from '@/config/predict';
import { toFloat, fromQuote } from '@/config/scale';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import type { PositionSummary } from '@/lib/api/types';
import { positionMetrics } from './position-metrics';
import { RedeemModal } from './redeem-modal';
import { RangeRedeemModal } from './range-redeem-modal';

/** Max position cards shown in the rail before deferring to Portfolio. */
const MAX_SHOWN = 3;

export function OpenPositions() {
  const { managerId, positions, positionsLoading, redeem, redeemRange, busy } = usePredictAccount();
  const rangesData = useRangePositions(managerId);
  const [redeeming, setRedeeming] = useState<PositionSummary | null>(null);
  const [redeemingRange, setRedeemingRange] = useState<ValuedRangePosition | null>(null);

  const sym = predictConfig.quote.symbol;

  // No trading account yet → nothing to show (mirrors the old FlowPanel gate).
  if (!managerId) return null;

  const openPositions = positions.filter((p) => p.open_quantity > 0);
  const openRanges = rangesData.positions.filter((p) => p.openQty > 0);
  const total = openPositions.length + openRanges.length;

  // Cap at 3 TOTAL across both kinds (binaries first, then ranges).
  const shownPositions = openPositions.slice(0, MAX_SHOWN);
  const shownRanges = openRanges.slice(0, Math.max(0, MAX_SHOWN - shownPositions.length));

  return (
    // Owns its own top divider (desktop) so it only appears when there's content
    // — keeps the rail clean for users without an account/positions. `font-mono
    // tabular-nums` mirrors the FlowPanel root this block used to live under, so
    // the prices/PnL render in the terminal's monospace figures, not the UI sans.
    <div className="flex flex-col gap-2 font-mono text-[12px] tabular-nums lg:border-t lg:border-line lg:pt-5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-text-3">Open positions</span>
        <Link href="/portfolio" className="text-[10px] text-text-2 underline hover:text-text-1">
          Portfolio →
        </Link>
      </div>
      {positionsLoading || rangesData.loading ? (
        <span className="text-text-3">loading…</span>
      ) : total === 0 ? (
        <span className="text-text-2">No open positions yet — pick a market above and place your first bet.</span>
      ) : (
        <>
          {shownPositions.map((p) => {
            const m = positionMetrics(p);
            // A lost (settled) bet marks to exactly 0 — nothing to redeem, so
            // "Clear" it. A live position always carries some positive value.
            const worthless = m.value != null && m.value <= 0;
            return (
              <div
                key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                className={`glass-card interactive flex items-center justify-between py-2 pl-3.5 pr-2 ${
                  p.is_up ? 'up' : 'down'
                }`}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`text-[10px] font-medium uppercase tracking-wider ${
                        p.is_up ? 'text-up' : 'text-down'
                      }`}
                    >
                      {p.is_up ? 'UP' : 'DOWN'}
                    </span>
                    <span className="text-text-1">{price(toFloat(p.strike))}</span>
                  </span>
                  <span className="text-[10px] text-text-3">
                    {fmtQuote(m.contracts)} {sym} to win ·{' '}
                    <span className={m.pnl >= 0 ? 'text-up' : 'text-down'}>
                      {signed(m.pnl)} ({signed(m.pnlPct * 100, 1)}%)
                    </span>
                  </span>
                </div>
                <button
                  onClick={() => setRedeeming(p)}
                  disabled={!!busy}
                  className="ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-text-2 disabled:opacity-50"
                >
                  {worthless ? 'Clear' : m.isSettled ? 'Redeem' : 'Close'}
                </button>
              </div>
            );
          })}
          {shownRanges.map((p) => {
            const rPnl = fromQuote(p.unrealizedPnl);
            // Settled out of band marks to exactly 0 — "Clear" it, don't "Redeem".
            const worthless = p.currentValue <= 0;
            return (
              <div
                key={`${p.oracleId}-${p.lowerStrike}-${p.higherStrike}`}
                className="glass-card interactive up flex items-center justify-between py-2 pl-3.5 pr-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-up">
                      RANGE
                    </span>
                    <span className="truncate text-text-1">
                      {price(toFloat(p.lowerStrike))}–{price(toFloat(p.higherStrike))}
                    </span>
                  </span>
                  <span className="text-[10px] text-text-3">
                    {fmtQuote(fromQuote(p.openQty))} {sym} to win ·{' '}
                    <span className={rPnl >= 0 ? 'text-up' : 'text-down'}>{signed(rPnl)}</span>
                  </span>
                </div>
                <button
                  onClick={() => setRedeemingRange(p)}
                  disabled={!!busy}
                  className="ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-text-2 disabled:opacity-50"
                >
                  {worthless ? 'Clear' : p.settled ? 'Redeem' : 'Close'}
                </button>
              </div>
            );
          })}
          {total > MAX_SHOWN && (
            <Link
              href="/portfolio"
              className="text-[10px] text-text-3 underline hover:text-text-2"
            >
              view all {total} positions →
            </Link>
          )}
        </>
      )}

      <RedeemModal
        position={redeeming}
        busy={!!busy}
        onConfirm={async (p, quantityBase) => {
          await redeem(p, quantityBase);
          setRedeeming(null);
        }}
        onClose={() => setRedeeming(null)}
      />

      <RangeRedeemModal
        position={redeemingRange}
        busy={!!busy}
        onConfirm={async (p, quantityBase) => {
          await redeemRange({
            oracleId: p.oracleId,
            expiry: p.expiry,
            lowerStrike: BigInt(Math.round(p.lowerStrike)),
            higherStrike: BigInt(Math.round(p.higherStrike)),
            quantity: quantityBase,
          });
          setRedeemingRange(null);
        }}
        onClose={() => setRedeemingRange(null)}
      />
    </div>
  );
}
