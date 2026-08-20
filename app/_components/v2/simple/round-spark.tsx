'use client';

/**
 * RoundSpark — the thumbnail price line on a round card: the same BTC tape as the hero
 * chart, with THAT round's line threaded through it as a dashed rule so the card answers
 * "am I above or below on this one?" at a glance.
 *
 * It draws from the series the screen already built, so a wall of these costs no extra
 * network and none of them can disagree with the big chart. The visible WINDOW differs
 * per card (see `windowS` at the call site) — a 1-minute round shows a tight recent
 * slice, an hourly round the full buffer — which is what stops a row of cards on one
 * asset from looking like the same picture repeated.
 */
import { useId, useMemo } from 'react';
import { curvePath, layoutRuns, sliceWindow, type SpotPoint } from '@/lib/charts/simple-series';

const UP = '#4dd6b0';
const DOWN = '#f0796b';
const W = 300;
const H = 88;
const PAD_Y = 10;

/** Keep a flat tape from magnifying into a fake rollercoaster (chart parity). */
const MIN_SPAN_FRAC = 0.0002;
const MIN_SPAN_ABS = 4;

export function RoundSpark({
  series,
  line,
  above,
  windowS,
}: {
  series: SpotPoint[];
  line: number | null;
  above: boolean;
  windowS: number;
}) {
  const stroke = above ? UP : DOWN;
  // Each card needs its OWN gradient id — several sparks share a page and a duplicate
  // id would make them all paint the first one's fill. `useId` is stable across renders
  // and SSR/hydration; the colons it emits are stripped so `url(#…)` stays valid.
  const uid = `spark${useId().replace(/:/g, '')}`;

  const geom = useMemo(() => {
    // Ordinal x, same as the hero chart — see `layoutRuns`. A sparkline is the WORST
    // place for a time-proportional axis: at 300px wide, one slow poll used to eat a
    // visible slice of the whole thumbnail.
    const { runs, slots } = layoutRuns(sliceWindow(series, windowS));
    if (!runs.length || slots < 2) return null;
    const placed = runs.flat();
    let lo = Math.min(...placed.map((p) => p.p));
    let hi = Math.max(...placed.map((p) => p.p));
    if (line != null) {
      lo = Math.min(lo, line);
      hi = Math.max(hi, line);
    }
    const center = (lo + hi) / 2;
    const minSpan = Math.max(center * MIN_SPAN_FRAC, MIN_SPAN_ABS);
    if (hi - lo < minSpan) {
      lo = center - minSpan / 2;
      hi = center + minSpan / 2;
    }
    const pad = (hi - lo) * 0.18;
    lo -= pad;
    hi += pad;
    const range = hi - lo || 1;
    const x = (i: number) => (i / (slots - 1)) * W;
    const y = (p: number) => PAD_Y + (1 - (p - lo) / range) * (H - 2 * PAD_Y);
    const paths = runs.map((run) => {
      const p = run.map((pt) => ({ x: x(pt.i), y: y(pt.p) }));
      const d = curvePath(p);
      return { d, area: `${d} L ${p[p.length - 1].x.toFixed(1)} ${H} L ${p[0].x.toFixed(1)} ${H} Z` };
    });
    const tip = placed[placed.length - 1];
    return { paths, lineY: line != null ? y(line) : null, dotX: x(tip.i), dotY: y(tip.p) };
  }, [series, line, windowS]);

  if (!geom) return <div className="skeleton h-full w-full rounded-lg opacity-30" />;

  return (
    <div className="relative h-full w-full">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {geom.lineY != null && (
          <line
            x1="0"
            y1={geom.lineY}
            x2={W}
            y2={geom.lineY}
            stroke="rgba(139,144,153,0.5)"
            strokeWidth="1"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {geom.paths.map((run, i) => (
          <path key={`a${i}`} d={run.area} fill={`url(#${uid})`} />
        ))}
        {geom.paths.map((run, i) => (
          <path
            key={`l${i}`}
            d={run.d}
            fill="none"
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {/* live tip, matching the hero chart's pulse at thumbnail scale */}
      <span
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${(geom.dotX / W) * 100}%`, top: `${(geom.dotY / H) * 100}%` }}
      >
        <span
          className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ border: `1px solid ${stroke}`, animation: 'breathe 2.4s ease-in-out infinite' }}
        />
        <span
          className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: stroke, boxShadow: `0 0 8px ${stroke}` }}
        />
      </span>
    </div>
  );
}
