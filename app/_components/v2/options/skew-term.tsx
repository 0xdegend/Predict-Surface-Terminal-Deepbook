'use client';

/**
 * SkewTerm — the shape of the market: at-the-money jumpiness across expiries (the term
 * structure) with the surface's no-arb verdict, a compact 2-D companion to the 3-D
 * surface. Underneath the bars, a Pro table gives the three shape numbers as figures
 * rather than heights: ATM implied vol, the 25-delta-equivalent risk reversal (which
 * side is the dear one), and the forward's premium to spot.
 */
import { useMemo } from 'react';
import { signed } from '@/lib/format';
import { Term } from './vocab';
import { expiryLabel, forwardBasisPct, riskReversal } from '@/lib/insights';
import type { MarketExpiry, ArbState } from '@/lib/insights';
import type { LivePricer } from '@/lib/sui/v2/pricer';

/** Below this, a shape number is zero for any practical purpose — and printing it as
 *  "-0.0" reads as a broken figure rather than a flat one. */
const snapZero = (x: number, eps = 0.05) => (Math.abs(x) < eps ? 0 : x);

export function SkewTerm({
  expiries,
  arb,
  now,
  pricers,
  spot,
}: {
  expiries: MarketExpiry[];
  arb: ArbState | null;
  now: number;
  /** Live pricer per market — the smile the shape numbers are read off. */
  pricers?: Record<string, LivePricer>;
  /** Live spot, for the forward basis. */
  spot?: number | null;
}) {
  const rows = expiries.slice(0, 6);
  const shape = useMemo(
    () =>
      rows.map((r) => {
        const p = pricers?.[r.marketId];
        return {
          marketId: r.marketId,
          rr: p ? riskReversal(p, r.expiryMs, now) : null,
          basis: p ? forwardBasisPct(p.forward, spot) : null,
        };
      }),
    [rows, pricers, spot, now],
  );
  if (rows.length === 0) return null;
  const maxIv = Math.max(...rows.map((r) => r.iv), 1e-9);
  const hasShape = shape.some((s) => s.rr || s.basis != null);

  return (
    <div className="glass rounded-lg p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-text-1">
          <Term plain="How jumpy each expiry is" pro="ATM IV term structure" />
        </h3>
        {arb && (
          <span
            className={`ml-auto rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ${
              arb === 'clean' ? 'bg-(--accent-soft) text-accent ring-(--accent-line)' : 'bg-down/10 text-down ring-down/30'
            }`}
          >
            {arb === 'clean' ? 'Arb-free ✓' : 'Mispricing'}
          </span>
        )}
      </div>
      <div className="flex items-end gap-2.5" style={{ height: 96 }}>
        {rows.map((r) => (
          <div key={r.marketId} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="font-mono text-[11px] tabular-nums text-text-1">{(r.iv * 100).toFixed(0)}%</span>
            <div
              className="w-full rounded-t border border-b-0 border-(--accent-line) bg-(--accent-soft) bg-[linear-gradient(180deg,rgba(255,255,255,0.16),transparent_42%)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)]"
              style={{ height: `${Math.max(8, (r.iv / maxIv) * 100)}%` }}
            />
            <span className="text-[10.5px] text-text-3">{expiryLabel(r.expiryMs, now)}</span>
          </div>
        ))}
      </div>

      {/* The same expiries as figures. Risk reversal is the call-side IV minus the
          put-side IV at symmetric 25%/75% chance strikes: negative means downside is the
          expensive side, the usual crypto shape. Basis is the forward's premium to spot.
          Both are Pro-only by virtue of living in the Context section. */}
      {hasShape && (
        <table className="mt-4 w-full border-collapse font-mono text-[11.5px] tabular-nums">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-text-3">
              <th className="border-b border-line pb-1.5 text-left font-medium">Expiry</th>
              <th className="border-b border-line pb-1.5 text-right font-medium">ATM IV</th>
              <th className="border-b border-line pb-1.5 text-right font-medium" title="Call-side IV minus put-side IV, at the 25% / 75% chance strikes">
                RR 25d
              </th>
              <th className="border-b border-line pb-1.5 text-right font-medium" title="Forward premium to spot, in basis points">
                Basis bps
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const sh = shape[i];
              return (
                <tr key={r.marketId} className="border-b border-line/50 last:border-0">
                  <td className="py-1.5 text-left text-text-2">{expiryLabel(r.expiryMs, now)}</td>
                  <td className="py-1.5 text-right text-text-1">{(r.iv * 100).toFixed(1)}%</td>
                  <td className={`py-1.5 text-right ${sh.rr == null ? 'text-text-3' : snapZero(sh.rr.rr25Pts) < 0 ? 'text-down' : 'text-up'}`}>
                    {sh.rr ? signed(snapZero(sh.rr.rr25Pts), 1) : '—'}
                  </td>
                  {/* In BASIS POINTS, not percent: these expiries are minutes out, so the
                      forward premium is a fraction of a percent and a % column would be a
                      row of +0.00%. Bps is the unit a desk quotes it in anyway. */}
                  <td className={`py-1.5 text-right ${sh.basis == null ? 'text-text-3' : snapZero(sh.basis * 100) >= 0 ? 'text-up' : 'text-down'}`}>
                    {sh.basis != null ? signed(snapZero(sh.basis * 100), 1) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
