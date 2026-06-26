'use client';

/**
 * MarketHeatmap — the Markets tool. A metric drives both views: a stock-heatmap
 * TREEMAP (size ∝ metric, color ∝ crowd mood) for the at-a-glance "where's the
 * action", and a dense TABLE for quants. Tap anything to bet its ATM strike.
 *
 * Design note (§10.3): the cool→warm IV ramp belongs to the 3-D surface alone,
 * so heat here is the single accent tint + the semantic up/down mood colors —
 * never a competing rainbow.
 */
import { useState } from 'react';
import { LuGrid3X3, LuRefreshCw, LuLayoutDashboard, LuTable } from 'react-icons/lu';
import { useMarketGrid } from '@/lib/hooks/use-market-grid';
import { useCopyTrade } from '@/lib/hooks/use-copy-trade';
import { type GridMetric, type MarketCell } from '@/lib/analytics/market-grid';
import { ErrorState } from '../ui/error-state';
import { MarketTreemap } from './market-treemap';
import { MarketTable } from './market-table';

const METRICS: { id: GridMetric; label: string }[] = [
  { id: 'volume', label: 'Money bet' },
  { id: 'oi', label: 'Open bets' },
  { id: 'iv', label: 'Price swing' },
  { id: 'sentiment', label: 'Sentiment' },
];

type View = 'map' | 'table';

export function MarketHeatmap() {
  const { cells, loading, refreshing, error, refetch } = useMarketGrid();
  const [metric, setMetric] = useState<GridMetric>('volume');
  const [view, setView] = useState<View>('map');
  const { copyBinary } = useCopyTrade();

  const onTrade = (c: MarketCell) =>
    copyBinary({ oracleId: c.oracleId, expiry: c.expiry, strikeScaled: c.atmStrikeScaled, strike: c.atmStrike, isUp: c.upShare >= 0.5 });

  if (error) {
    return (
      <ErrorState
        title="Market grid unavailable"
        message={error}
        note="This reads the public market + event data — usually a brief hiccup."
      />
    );
  }

  return (
    <div className="glass-card overflow-hidden">
      {/* Header — title · metric toggle · view toggle · refresh */}
      <div className="head-divider flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <LuGrid3X3 size={15} className="text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-text-1">Markets</span>
          <span className="eyebrow text-text-3">size = {METRICS.find((m) => m.id === metric)?.label} · color = sentiment</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {METRICS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMetric(m.id)}
                aria-pressed={metric === m.id}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium tracking-tight transition-colors ${
                  metric === m.id ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {/* view toggle */}
          <div className="glass-inset flex items-center gap-0.5 rounded-md p-0.5">
            <ViewBtn active={view === 'map'} onClick={() => setView('map')} icon={LuLayoutDashboard} label="Map" />
            <ViewBtn active={view === 'table'} onClick={() => setView('table')} icon={LuTable} label="Table" />
          </div>
          <button
            onClick={refetch}
            disabled={loading}
            aria-label="Refresh"
            className="group glass-inset inline-flex items-center justify-center p-1.5 text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 disabled:opacity-50"
          >
            <LuRefreshCw size={12} className={`transition-colors duration-200 group-hover:text-accent ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className={view === 'map' ? 'p-3' : 'pb-1'}>
        {loading ? (
          view === 'map' ? (
            <div className="h-110 w-full skeleton rounded-lg" />
          ) : (
            <TableSkeleton />
          )
        ) : cells.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-text-3">
            <LuGrid3X3 size={20} className="mx-auto mb-2 opacity-40" />
            No live markets right now.
          </div>
        ) : view === 'map' ? (
          <MarketTreemap cells={cells} metric={metric} onTrade={onTrade} />
        ) : (
          <MarketTable cells={cells} metric={metric} onTrade={onTrade} />
        )}
      </div>
    </div>
  );
}

function ViewBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof LuTable;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function TableSkeleton() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <span className="h-3 w-24 flex-none rounded skeleton" />
          <span className="h-3 flex-1 rounded skeleton" />
          <span className="h-3 w-12 flex-none rounded skeleton" />
        </div>
      ))}
    </div>
  );
}
