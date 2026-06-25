'use client';

/**
 * MarketHeatmap — the market map: one tile per active market, colored by a
 * chosen metric (traded volume, open interest, ATM implied vol, or crowd
 * sentiment) so you can see where the action is at a glance. Click a tile to
 * open the trade ticket pre-filled at that market's ATM strike.
 *
 * Design note (§10.3): the cool→warm IV ramp belongs to the 3-D surface alone,
 * so "heat" here is encoded as the intensity of a single accent tint (and the
 * semantic up/down colors for sentiment) — never a competing rainbow.
 */
import { useMemo, useState } from 'react';
import { LuGrid3X3, LuRefreshCw } from 'react-icons/lu';
import { useMarketGrid } from '@/lib/hooks/use-market-grid';
import { useCopyTrade } from '@/lib/hooks/use-copy-trade';
import { useNow } from '@/lib/hooks/use-now';
import {
  metricIntensities,
  metricValue,
  type GridMetric,
  type MarketCell,
} from '@/lib/analytics/market-grid';
import { compact, num, pct, ttl } from '@/lib/format';
import { ErrorState } from '../ui/error-state';

const METRICS: { id: GridMetric; label: string }[] = [
  { id: 'volume', label: 'Volume' },
  { id: 'oi', label: 'Open interest' },
  { id: 'iv', label: 'Implied vol' },
  { id: 'sentiment', label: 'Sentiment' },
];

export function MarketHeatmap() {
  const { cells, loading, refreshing, error, refetch } = useMarketGrid();
  const [metric, setMetric] = useState<GridMetric>('volume');
  const now = useNow(0);
  const { copyBinary } = useCopyTrade();

  const intensities = useMemo(() => metricIntensities(cells, metric), [cells, metric]);
  // Hottest markets first for the chosen metric, so the action floats to the top
  // (ties keep the natural expiry ladder).
  const sorted = useMemo(
    () => [...cells].sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || a.expiry - b.expiry),
    [cells, metric],
  );

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
      {/* Header + metric toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div className="flex items-center gap-2">
          <LuGrid3X3 size={15} className="text-[var(--accent)]" />
          <span className="text-[13px] font-semibold tracking-tight text-text-1">Market map</span>
          <span className="eyebrow text-text-3">active markets · tap to trade</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {METRICS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMetric(m.id)}
                aria-pressed={metric === m.id}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium tracking-tight transition-colors ${
                  metric === m.id
                    ? 'bg-(--accent-soft) text-text-1'
                    : 'text-text-2 hover:bg-white/4 hover:text-text-1'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            onClick={refetch}
            disabled={loading}
            aria-label="Refresh"
            className="group glass-inset inline-flex items-center justify-center p-1.5 text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 disabled:opacity-50"
          >
            <LuRefreshCw
              size={12}
              className={`transition-colors duration-200 group-hover:text-accent ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="p-3">
        {loading ? (
          <SkeletonGrid />
        ) : cells.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-text-3">
            <LuGrid3X3 size={20} className="mx-auto mb-2 opacity-40" />
            No active markets right now.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {sorted.map((c) => (
              <MarketTile
                key={c.oracleId}
                cell={c}
                metric={metric}
                intensity={intensities.get(c.oracleId) ?? 0}
                now={now}
                onTrade={() =>
                  copyBinary({
                    oracleId: c.oracleId,
                    expiry: c.expiry,
                    strikeScaled: c.atmStrikeScaled,
                    strike: c.atmStrike,
                    isUp: true,
                  })
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Background tint for a tile — accent intensity for magnitude metrics, the
 *  leading side's semantic color for sentiment. Kept quiet (≤18% mix). */
function tileTint(cell: MarketCell, metric: GridMetric, intensity: number): string {
  if (metric === 'sentiment') {
    const strength = Math.abs(cell.upShare - 0.5) * 2;
    const hue = cell.upShare >= 0.5 ? 'var(--up)' : 'var(--down)';
    return `color-mix(in srgb, ${hue} ${Math.round(strength * 16)}%, transparent)`;
  }
  return `color-mix(in srgb, var(--accent) ${Math.round(intensity * 18)}%, transparent)`;
}

function MarketTile({
  cell,
  metric,
  intensity,
  now,
  onTrade,
}: {
  cell: MarketCell;
  metric: GridMetric;
  intensity: number;
  now: number;
  onTrade: () => void;
}) {
  const leadUp = cell.upShare >= 0.5;
  const headline = metricHeadline(cell, metric);
  const barFrac = metric === 'sentiment' ? Math.abs(cell.upShare - 0.5) * 2 : intensity;

  return (
    <button
      onClick={onTrade}
      title={`Trade ${cell.underlying} ATM (${num(cell.atmStrike, 0)}) · expires ${ttl(cell.expiry, now)}`}
      className="group glass-inset relative flex flex-col gap-2 overflow-hidden rounded-lg p-3 text-left transition-all duration-200 hover:border-(--accent-line)"
      style={{ background: tileTint(cell, metric, intensity) }}
    >
      {/* header — underlying + time to expiry */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-text-2">{cell.underlying}</span>
        <span className="font-mono text-[10px] tabular-nums text-text-3">{ttl(cell.expiry, now)}</span>
      </div>

      {/* headline metric */}
      <div>
        <div className="font-mono text-[17px] font-semibold leading-none tracking-tight text-text-1">
          {headline.value}
        </div>
        <div className="eyebrow mt-1 text-text-3">{headline.label}</div>
      </div>

      {/* footer — forward + ATM IV, always visible for context */}
      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums text-text-3">
        <span>{num(cell.forward, 0)}</span>
        <span className={leadUp ? 'text-up' : 'text-down'}>
          {Math.round(cell.upShare * 100)}% {leadUp ? 'UP' : 'DN'}
        </span>
      </div>

      {/* intensity bar */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-bg-3">
        <span
          className="block h-full transition-[width] duration-500"
          style={{
            width: `${Math.max(2, Math.round(barFrac * 100))}%`,
            background: metric === 'sentiment' ? (leadUp ? 'var(--up)' : 'var(--down)') : 'var(--accent)',
          }}
        />
      </span>
    </button>
  );
}

function metricHeadline(cell: MarketCell, metric: GridMetric): { value: string; label: string } {
  switch (metric) {
    case 'volume':
      return { value: compact(cell.volume), label: `DUSDC · ${cell.trades} bets` };
    case 'oi':
      return { value: compact(cell.openInterest), label: 'open contracts' };
    case 'iv':
      return { value: pct(cell.atmIv, 0), label: 'ATM implied vol' };
    case 'sentiment':
      return {
        value: `${Math.round((cell.upShare >= 0.5 ? cell.upShare : 1 - cell.upShare) * 100)}%`,
        label: cell.upShare >= 0.5 ? 'lean UP' : 'lean DOWN',
      };
  }
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="glass-inset flex h-[104px] flex-col gap-2 rounded-lg p-3">
          <div className="flex justify-between">
            <span className="h-3 w-8 rounded bg-line-soft" />
            <span className="h-3 w-8 rounded bg-line-soft" />
          </div>
          <span className="mt-1 h-5 w-16 rounded bg-line-soft" />
          <span className="h-2.5 w-20 rounded bg-line-soft" />
        </div>
      ))}
    </div>
  );
}
