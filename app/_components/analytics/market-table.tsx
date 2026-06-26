'use client';

/**
 * MarketTable — the dense, quant-leaning view of the markets: every live market
 * a row with money bet, open bets, expected swing, and crowd mood side by side,
 * sorted by the active metric. Heat bars give each number an at-a-glance scale.
 * Tap a row to bet its ATM strike.
 *
 * The column template is applied via inline `gridTemplateColumns` (not a Tailwind
 * arbitrary class held in a JS variable — Tailwind can't always see those, which
 * desynced the header from the rows). Header + rows share this one constant, so
 * they can never misalign, and equal fr tracks fill the width evenly.
 */
import { useMemo } from 'react';
import { metricValue, type GridMetric, type MarketCell } from '@/lib/analytics/market-grid';
import { compact, num, pct, ttl } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';

const GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.1fr)',
  gap: '0.75rem',
  alignItems: 'center',
};

export function MarketTable({
  cells,
  metric,
  onTrade,
}: {
  cells: MarketCell[];
  metric: GridMetric;
  onTrade: (c: MarketCell) => void;
}) {
  const now = useNow(0);
  const sorted = useMemo(
    () => [...cells].sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || a.expiry - b.expiry),
    [cells, metric],
  );
  const maxVol = Math.max(1, ...cells.map((c) => c.volume));

  return (
    <div className="overflow-x-auto">
      <div className="min-w-136">
        {/* Column header */}
        <div style={GRID} className="px-4 py-2 text-text-3">
          <span className="eyebrow">Market</span>
          <span className="eyebrow">Ends</span>
          <span className="eyebrow">Money bet</span>
          <span className="eyebrow text-right">Open</span>
          <span className="eyebrow text-right">Swing</span>
          <span className="eyebrow text-right">Sentiment</span>
        </div>

        <div className="rows-divided">
          {sorted.map((c) => {
            const leadUp = c.upShare >= 0.5;
            const upPct = Math.round(c.upShare * 100);
            return (
              <button
                key={c.oracleId}
                onClick={() => onTrade(c)}
                style={GRID}
                className="w-full px-4 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
              >
                {/* Market */}
                <span className="min-w-0 truncate font-mono text-[12px] text-text-1">
                  {c.underlying} {num(c.forward, 0)}
                </span>
                {/* Ends */}
                <span className="font-mono text-[11px] tabular-nums text-text-3">{ttl(c.expiry, now)}</span>
                {/* Money bet + heat bar */}
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-[12px] tabular-nums text-text-1">{compact(c.volume)}</span>
                  <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-bg-3">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round((c.volume / maxVol) * 100)}%`, opacity: 0.7 }} />
                  </span>
                </span>
                {/* Open bets */}
                <span className="text-right font-mono text-[12px] tabular-nums text-text-2">
                  {c.openInterest > 0 ? compact(c.openInterest) : <span className="text-text-3">—</span>}
                </span>
                {/* Swing (IV) */}
                <span className="text-right font-mono text-[12px] tabular-nums text-text-2">{pct(c.atmIv, 0)}</span>
                {/* Mood */}
                <span className="flex flex-col items-end gap-1">
                  <span className={`font-mono text-[11px] tabular-nums ${leadUp ? 'text-up' : 'text-down'}`}>
                    {leadUp ? upPct : 100 - upPct}% {leadUp ? 'UP' : 'DN'}
                  </span>
                  <span className="flex h-1 w-14 overflow-hidden rounded-full bg-bg-3">
                    <span className="h-full bg-up" style={{ width: `${upPct}%` }} />
                    <span className="h-full bg-down" style={{ width: `${100 - upPct}%` }} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
