'use client';

/**
 * VolTab — the implied-vol analytics tool (Analytics Phase 3): a 2-D reading of
 * the same vol the 3-D surface renders.
 *   - Term structure: current ATM IV across every live expiry (click a node to
 *     drill in).
 *   - ATM-IV history: how the selected market's ATM vol has moved over time.
 * SVG charts in the house line-chart idiom (see risk-panel PerfChart). Server-
 * data only — renders for any visitor.
 */
import { useMemo, useState } from 'react';
import { LuActivity, LuWaves } from 'react-icons/lu';
import { useMarketGrid } from '@/lib/hooks/use-market-grid';
import { useVolHistory } from '@/lib/hooks/use-vol-history';
import { useNow } from '@/lib/hooks/use-now';
import { buildTermStructure, type IvHistoryPoint, type TermPoint } from '@/lib/analytics/vol-curves';
import { pct, ttl, timeUTC } from '@/lib/format';
import { ErrorState } from '../ui/error-state';

export function VolTab() {
  const { cells, loading, error } = useMarketGrid();
  const now = useNow(0);
  const [picked, setPicked] = useState<string | null>(null);

  const term = useMemo(() => buildTermStructure(cells, now), [cells, now]);
  // Selection is derived (no effect): the picked market if still live, else the
  // nearest expiry. Falls back cleanly when a market settles out of the curve.
  const selected = term.find((t) => t.oracleId === picked) ?? term[0] ?? null;

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
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="flex items-center gap-2">
            <LuWaves size={15} className="text-accent" />
            <span className="text-[13px] font-semibold tracking-tight text-text-1">Term structure</span>
            <span className="eyebrow text-text-3">ATM implied vol by expiry · tap a point</span>
          </div>
        </div>
        <div className="p-4">
          {loading ? (
            <ChartSkeleton />
          ) : term.length === 0 ? (
            <Empty label="No live markets to chart." />
          ) : (
            <TermChart term={term} selectedId={selected?.oracleId ?? null} onPick={setPicked} now={now} />
          )}
        </div>
      </div>

      {/* ATM IV history for the selected market */}
      <VolHistoryCard selected={selected} now={now} />
    </div>
  );
}

/* ----------------------------- term chart ----------------------------- */

const W = 580;
const H = 150;
const PAD_X = 30;
const PAD_Y = 16;

function TermChart({
  term,
  selectedId,
  onPick,
  now,
}: {
  term: TermPoint[];
  selectedId: string | null;
  onPick: (id: string) => void;
  now: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ys = term.map((p) => p.atmIv);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const n = term.length;

  const sx = (i: number) => PAD_X + (n <= 1 ? (W - 2 * PAD_X) / 2 : (i / (n - 1)) * (W - 2 * PAD_X));
  const sy = (y: number) => PAD_Y + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD_Y);

  const line = term.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p.atmIv).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(n - 1).toFixed(1)},${H - PAD_Y} L${sx(0).toFixed(1)},${H - PAD_Y} Z`;

  const selIdx = term.findIndex((p) => p.oracleId === selectedId);
  const active = hover != null ? term[hover] : selIdx >= 0 ? term[selIdx] : null;

  return (
    <div className="relative">
      {/* readout */}
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[18px] font-semibold tabular-nums text-text-1">
          {active ? pct(active.atmIv, 1) : '—'}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-text-3">
          {active ? `expires ${ttl(active.expiry, now)}` : `${n} live expiries`}
        </span>
      </div>

      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="block touch-none"
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="term-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(77,214,176,0.16)" />
            <stop offset="100%" stopColor="rgba(77,214,176,0)" />
          </linearGradient>
        </defs>

        {/* y gridlines + labels (max / min IV) */}
        <text x={2} y={sy(yMax) + 3} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {pct(yMax, 0)}
        </text>
        <text x={2} y={sy(yMin) + 3} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {pct(yMin, 0)}
        </text>

        <path d={area} fill="url(#term-fill)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.5} />

        {/* nodes (clickable) */}
        {term.map((p, i) => {
          const isSel = p.oracleId === selectedId;
          const isHover = hover === i;
          return (
            <g key={p.oracleId} className="cursor-pointer" onClick={() => onPick(p.oracleId)} onPointerEnter={() => setHover(i)}>
              {/* invisible hit target */}
              <rect x={sx(i) - 10} y={0} width={20} height={H} fill="transparent" />
              <circle cx={sx(i)} cy={sy(p.atmIv)} r={isSel || isHover ? 4 : 2.5} fill="var(--accent)" opacity={isSel || isHover ? 1 : 0.65} />
              {isSel && <circle cx={sx(i)} cy={sy(p.atmIv)} r={7} fill="none" stroke="var(--accent)" strokeWidth={1} opacity={0.4} />}
            </g>
          );
        })}
      </svg>

      {/* x ticks — first / last expiry */}
      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-text-3">
        <span>{ttl(term[0].expiry, now)}</span>
        <span>{ttl(term[n - 1].expiry, now)}</span>
      </div>
    </div>
  );
}

/* ---------------------------- history chart --------------------------- */

function VolHistoryCard({ selected, now }: { selected: TermPoint | null; now: number }) {
  const { series, loading, error } = useVolHistory(
    selected ? { oracleId: selected.oracleId, expiry: selected.expiry } : null,
  );

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div className="flex items-center gap-2">
          <LuActivity size={15} className="text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-text-1">ATM IV history</span>
          {selected && (
            <span className="eyebrow text-text-3">
              {selected.underlying ?? 'BTC'} · expires {ttl(selected.expiry, now)}
            </span>
          )}
        </div>
      </div>
      <div className="p-4">
        {error ? (
          <Empty label={error} />
        ) : !selected || loading ? (
          <ChartSkeleton />
        ) : series.length < 2 ? (
          <Empty label="Not enough history for this market yet." />
        ) : (
          <IvHistoryChart series={series} />
        )}
      </div>
    </div>
  );
}

function IvHistoryChart({ series }: { series: IvHistoryPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ys = series.map((p) => p.atmIv);
  const xs = series.map((p) => p.ts);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  const sx = (x: number) => PAD_X + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD_X);
  const sy = (y: number) => PAD_Y + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD_Y);
  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.ts).toFixed(1)},${sy(p.atmIv).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(xMax).toFixed(1)},${H - PAD_Y} L${sx(xMin).toFixed(1)},${H - PAD_Y} Z`;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < series.length; i++) {
      if (Math.abs(sx(series[i].ts) - vx) < Math.abs(sx(series[best].ts) - vx)) best = i;
    }
    setHover(best);
  }

  const hp = hover != null ? series[hover] : series[series.length - 1];
  const first = series[0].atmIv;
  const changePts = (hp.atmIv - first) * 100; // IV is a ratio → pts of vol

  return (
    <div className="relative">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[18px] font-semibold tabular-nums text-text-1">{pct(hp.atmIv, 1)}</span>
        <span className={`font-mono text-[11px] tabular-nums ${changePts >= 0 ? 'text-up' : 'text-down'}`}>
          {changePts >= 0 ? '+' : ''}
          {changePts.toFixed(1)} pts
        </span>
      </div>

      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="block cursor-crosshair touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ivh-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(77,214,176,0.16)" />
            <stop offset="100%" stopColor="rgba(77,214,176,0)" />
          </linearGradient>
        </defs>
        <text x={2} y={sy(yMax) + 3} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {pct(yMax, 0)}
        </text>
        <text x={2} y={sy(yMin) + 3} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {pct(yMin, 0)}
        </text>
        <path d={area} fill="url(#ivh-fill)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.25} />
        {hover != null && (
          <>
            <line x1={sx(hp.ts)} y1={PAD_Y} x2={sx(hp.ts)} y2={H - PAD_Y} stroke="var(--accent)" strokeWidth={0.75} opacity={0.5} />
            <circle cx={sx(hp.ts)} cy={sy(hp.atmIv)} r={3.5} fill="var(--accent)" opacity={0.25} />
            <circle cx={sx(hp.ts)} cy={sy(hp.atmIv)} r={2} fill="var(--accent)" />
          </>
        )}
      </svg>

      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-text-3">
        <span>{timeUTC(xMin)}</span>
        <span>{timeUTC(xMax)}</span>
      </div>
    </div>
  );
}

/* ------------------------------- bits -------------------------------- */

function Empty({ label }: { label: string }) {
  return <div className="py-10 text-center text-[12px] text-text-3">{label}</div>;
}

function ChartSkeleton() {
  return <div className="h-[150px] w-full animate-pulse rounded-lg bg-line-soft/40" />;
}
