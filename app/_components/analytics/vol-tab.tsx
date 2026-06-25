'use client';

/**
 * VolTab — the implied-vol analytics tool: a 2-D reading of the same vol the 3-D
 * surface renders.
 *   - Term structure: current expected price swing across every live expiry
 *     (tap a node to drill in).
 *   - Price-swing history: how the selected market's swing has moved over time.
 * Charts are the shared visx LineChart (gridlines, crosshair tooltip; the term
 * structure uses a sqrt scale so the ultra-short market's spike doesn't squash
 * the rest). Server-data only.
 */
import { useMemo, useState } from 'react';
import { LuActivity, LuWaves } from 'react-icons/lu';
import { useMarketGrid } from '@/lib/hooks/use-market-grid';
import { useVolHistory } from '@/lib/hooks/use-vol-history';
import { useNow } from '@/lib/hooks/use-now';
import { buildTermStructure, type TermPoint } from '@/lib/analytics/vol-curves';
import { pct, ttl, timeUTC } from '@/lib/format';
import { ErrorState } from '../ui/error-state';
import { LineChart, type ChartPoint } from './charts/line-chart';

export function VolTab() {
  const { cells, loading, error } = useMarketGrid();
  const now = useNow(0);
  const [picked, setPicked] = useState<string | null>(null);

  const term = useMemo(() => buildTermStructure(cells, now), [cells, now]);
  const selIdx = term.findIndex((t) => t.oracleId === picked);
  const selected = (selIdx >= 0 ? term[selIdx] : term[0]) ?? null;

  if (error) {
    return (
      <ErrorState
        title="Vol analytics unavailable"
        message={error}
        note="This reads the public market + SVI data — usually a brief hiccup."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Term structure */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider flex items-center gap-2 px-4 py-3">
          <LuWaves size={15} className="text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-text-1">Expected price swings</span>
          <span className="eyebrow text-text-3">how jumpy each market is · tap a point</span>
        </div>
        <div className="p-4">
          <p className="mb-3 text-[11.5px] leading-relaxed text-text-3">
            How big a price move traders are expecting for each market. A higher point means a bumpier,
            less certain market — the price could swing more before it ends.
          </p>
          {loading ? (
            <ChartSkeleton />
          ) : term.length < 2 ? (
            <Empty label="Not enough live markets to chart yet." />
          ) : (
            <>
              <Readout value={selected ? pct(selected.atmIv, 1) : '—'} meta={selected ? `ends in ${ttl(selected.expiry, now)}` : ''} />
              <TermChart term={term} selectedIndex={selIdx >= 0 ? selIdx : 0} onPick={(i) => setPicked(term[i].oracleId)} now={now} />
            </>
          )}
        </div>
      </div>

      {/* Price-swing history for the selected market */}
      <VolHistoryCard selected={selected} now={now} />
    </div>
  );
}

function TermChart({
  term,
  selectedIndex,
  onPick,
  now,
}: {
  term: TermPoint[];
  selectedIndex: number;
  onPick: (i: number) => void;
  now: number;
}) {
  const points: ChartPoint[] = term.map((p, i) => ({ x: i, y: p.atmIv, label: ttl(p.expiry, now) }));
  // One ultra-short market can have a huge swing; compress with a sqrt scale when
  // the top sits far above the typical level, so the curve body stays readable.
  const ys = [...term.map((p) => p.atmIv)].sort((a, b) => a - b);
  const median = ys[Math.floor(ys.length / 2)] || 1;
  const scaleType = ys[ys.length - 1] > median * 4 ? 'sqrt' : 'linear';

  return (
    <LineChart
      points={points}
      height={160}
      yFormat={(n) => pct(n, 0)}
      yScaleType={scaleType}
      showDots
      selectedIndex={selectedIndex}
      onPick={onPick}
      xCaptions={[ttl(term[0].expiry, now), ttl(term[term.length - 1].expiry, now)]}
    />
  );
}

function VolHistoryCard({ selected, now }: { selected: TermPoint | null; now: number }) {
  const { series, loading, error } = useVolHistory(
    selected ? { oracleId: selected.oracleId, expiry: selected.expiry } : null,
  );

  const current = series.length ? series[series.length - 1].atmIv : 0;
  const jumpier = series.length >= 2 ? series[series.length - 1].atmIv >= series[0].atmIv : true;
  const points: ChartPoint[] = series.map((p) => ({ x: p.ts, y: p.atmIv, label: timeUTC(p.ts) }));

  return (
    <div className="glass-card overflow-hidden">
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <LuActivity size={15} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Price-swing history</span>
        {selected && (
          <span className="eyebrow text-text-3">
            {selected.underlying ?? 'BTC'} · ends in {ttl(selected.expiry, now)}
          </span>
        )}
      </div>
      <div className="p-4">
        {error ? (
          <Empty label={error} />
        ) : !selected || loading ? (
          <ChartSkeleton />
        ) : series.length < 2 ? (
          <Empty label="Not enough history for this market yet." />
        ) : (
          <>
            <Readout
              value={pct(current, 1)}
              meta={jumpier ? 'jumpier than earlier' : 'calmer than earlier'}
            />
            <LineChart
              points={points}
              height={160}
              yFormat={(n) => pct(n, 0)}
              xCaptions={[timeUTC(series[0].ts), timeUTC(series[series.length - 1].ts)]}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Readout({ value, meta }: { value: string; meta: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="font-mono text-[18px] font-semibold tabular-nums text-text-1">{value}</span>
      <span className="text-[11px] font-medium text-text-2">{meta}</span>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="py-10 text-center text-[12px] text-text-3">{label}</div>;
}

function ChartSkeleton() {
  return <div className="h-40 w-full skeleton rounded-lg" />;
}
