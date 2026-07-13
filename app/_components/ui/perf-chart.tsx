'use client';

/**
 * PerfChart — a share-price-over-time area chart with a hover scrubber. Extracted
 * from the legacy RiskPanel so the v2 risk panel reuses it. Generic over the
 * minimal point shape, so both the legacy `/vault/performance` points and the v2
 * flush-derived series satisfy it.
 */
import { useState } from 'react';
import { num, signed, dateUTC } from '@/lib/format';

export interface PerfPoint {
  timestamp_ms: number;
  share_price: number;
}

export function PerfChart({ points }: { points: PerfPoint[] }) {
  const W = 560;
  const H = 90;
  const PAD = 6;
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) return <p className="text-[11px] text-text-3">No history.</p>;
  const ys = points.map((p) => p.share_price);
  const xs = points.map((p) => p.timestamp_ms);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const sx = (x: number) => PAD + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
  const sy = (y: number) => PAD + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD);
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.timestamp_ms).toFixed(1)},${sy(p.share_price).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${sx(xMax).toFixed(1)},${H - PAD} L${sx(xMin).toFixed(1)},${H - PAD} Z`;

  // Map the pointer's x (viewBox units) to the nearest data point.
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(sx(points[i].timestamp_ms) - vx) < Math.abs(sx(points[best].timestamp_ms) - vx)) best = i;
    }
    setHover(best);
  }

  const hp = hover != null ? points[hover] : null;
  const hx = hp ? sx(hp.timestamp_ms) : 0;
  const hy = hp ? sy(hp.share_price) : 0;
  const first = points[0].share_price;
  const changePct = hp && first > 0 ? (hp.share_price / first - 1) * 100 : 0;

  return (
    <div className="relative">
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="block cursor-crosshair touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="perf-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(77,214,176,0.18)" />
            <stop offset="100%" stopColor="rgba(77,214,176,0)" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#perf-fill)" />
        <path d={line} fill="none" stroke="var(--up)" strokeWidth={1.25} />
        {hp && (
          <>
            <line x1={hx} y1={PAD} x2={hx} y2={H - PAD} stroke="var(--up)" strokeWidth={0.75} opacity={0.5} />
            <circle cx={hx} cy={hy} r={3.5} fill="var(--up)" opacity={0.2} />
            <circle cx={hx} cy={hy} r={2} fill="var(--up)" />
          </>
        )}
        <text x={PAD} y={11} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {num(yMax, 6)}
        </text>
        <text x={PAD} y={H - 2} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {num(yMin, 6)}
        </text>
      </svg>

      {hp && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-right glass">
          <div className="font-mono text-[13px] leading-none tabular-nums text-text-1">
            {num(hp.share_price, 6)}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1.5 font-mono text-[10px] leading-none tabular-nums">
            <span className={changePct >= 0 ? 'text-up' : 'text-down'}>{signed(changePct, 2)}%</span>
            <span className="text-text-3">{dateUTC(hp.timestamp_ms)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
