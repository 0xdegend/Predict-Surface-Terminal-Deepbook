'use client';

/**
 * SkewTerm — the shape of the market: at-the-money jumpiness across expiries (the
 * term structure) with the surface's no-arb verdict. A compact 2-D companion to
 * the 3-D surface.
 */
import { Term } from './vocab';
import type { MarketExpiry, ArbState } from '@/lib/insights';

function expiryLabel(ms: number, now: number): string {
  const m = Math.max(0, Math.round((ms - now) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

export function SkewTerm({ expiries, arb, now }: { expiries: MarketExpiry[]; arb: ArbState | null; now: number }) {
  const rows = expiries.slice(0, 6);
  if (rows.length === 0) return null;
  const maxIv = Math.max(...rows.map((r) => r.iv), 1e-9);

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
              className="w-full rounded-t border border-b-0 border-(--accent-line) bg-(--accent-soft)"
              style={{ height: `${Math.max(8, (r.iv / maxIv) * 100)}%` }}
            />
            <span className="text-[10.5px] text-text-3">{expiryLabel(r.expiryMs, now)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
