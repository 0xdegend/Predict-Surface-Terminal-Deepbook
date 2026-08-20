'use client';

/**
 * SimpleRoundChart — the calm live price chart for simple mode: the BTC line with the
 * round's LINE (strike) drawn as a dashed horizontal, tinted mint when price is above
 * it and coral when below, and a live pulsing dot at the edge.
 *
 * Self-contained SVG (no lightweight-charts), drawn from the series the screen builds
 * once in [[lib/hooks/use-spot-series]] — so it costs no network of its own and always
 * agrees with the round cards' sparklines. The series rules (per-second decimation,
 * honest gap breaks, monotone curve) live in [[lib/charts/simple-series]].
 *
 * It FILLS its container (no fixed height) so it never leaves dead space, stretching
 * via preserveAspectRatio="none"; strokes use vector-effect="non-scaling-stroke" so
 * they stay crisp, and the dot + "LINE" label are HTML overlays positioned by viewBox
 * percentage. The `above` tint is passed in (spot vs the line) so it always agrees with
 * the header's "above/below the line". See [[simple-mode]].
 */
import { useMemo } from 'react';
import { curvePath, layoutRuns, type SpotPoint } from '@/lib/charts/simple-series';
import { price } from '@/lib/format';

const UP = '#4dd6b0';
const DOWN = '#f0796b';
const W = 600;
const H = 240;
const PAD_Y = 20;

/** Floor for the vertical span, so a dead-flat tape doesn't magnify sub-dollar jitter
 *  into a fake rollercoaster (mirrors the full chart's autoscale floor). */
const MIN_SPAN_FRAC = 0.0002; // 0.02% of price (~$13 at $65k)
const MIN_SPAN_ABS = 4;

export function SimpleRoundChart({
  series,
  line,
  above,
  ready = true,
}: {
  series: SpotPoint[];
  line: number | null;
  above: boolean;
  /**
   * False while the history backfill is still in flight. The chart then holds its
   * skeleton instead of painting whatever has arrived: the seed lands seconds before
   * the full window, so drawing early meant showing a stub that visibly rewrote itself
   * once the real history joined on behind it. See [[lib/hooks/use-spot-series]].
   */
  ready?: boolean;
}) {
  const stroke = above ? UP : DOWN;

  const geom = useMemo(() => {
    // ORDINAL x, exactly like the advanced chart's lightweight-charts time scale: a
    // second we never sampled costs no width, so ordinary poll latency can't tear the
    // line. See `layoutRuns` for why this is the fix and the axis was the cause.
    const { runs, slots } = layoutRuns(series);
    if (!runs.length || slots < 2) return null;
    const placed = runs.flat();
    let lo = Math.min(...placed.map((p) => p.p));
    let hi = Math.max(...placed.map((p) => p.p));
    if (line != null) {
      lo = Math.min(lo, line);
      hi = Math.max(hi, line);
    }
    // Floor the span first (a flat tape would otherwise zoom into pure noise), then pad.
    const center = (lo + hi) / 2;
    const minSpan = Math.max(center * MIN_SPAN_FRAC, MIN_SPAN_ABS);
    if (hi - lo < minSpan) {
      lo = center - minSpan / 2;
      hi = center + minSpan / 2;
    }
    const pad = (hi - lo) * 0.15;
    lo -= pad;
    hi += pad;
    const range = hi - lo || 1;
    const x = (i: number) => (i / (slots - 1)) * W;
    const y = (p: number) => PAD_Y + (1 - (p - lo) / range) * (H - 2 * PAD_Y);
    // One path (and one area) per unbroken run — a break draws nothing at all.
    const paths = runs.map((run) => {
      const pts = run.map((pt) => ({ x: x(pt.i), y: y(pt.p) }));
      const d = curvePath(pts);
      return { d, area: `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z` };
    });
    // The live dot rides the last DRAWN point. Reading the raw tail instead would strand
    // it off the line whenever the newest point was a lone sample with nothing to join.
    const tip = placed[placed.length - 1];
    const lineY = line != null ? y(line) : null;
    return { paths, lineY, dotX: x(tip.i), dotY: y(tip.p) };
  }, [series, line]);

  return (
    // The floor rises on a desktop: the card's height comes from whichever of it and the
    // ticket is taller, so on a short laptop window the ticket won that and squeezed the
    // chart. A taller floor makes the chart the thing that sets the row height.
    <div className="relative h-full min-h-55 w-full overflow-hidden rounded-xl bg-bg-0/40 lg:min-h-90">
      {ready && geom ? (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
            <defs>
              <linearGradient id="simpleFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={stroke} stopOpacity="0.24" />
                <stop offset="1" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>
            <g stroke="rgba(255,255,255,0.045)" strokeWidth="1" vectorEffect="non-scaling-stroke">
              <line x1="0" y1={H * 0.25} x2={W} y2={H * 0.25} />
              <line x1="0" y1={H * 0.5} x2={W} y2={H * 0.5} />
              <line x1="0" y1={H * 0.75} x2={W} y2={H * 0.75} />
            </g>
            {geom.lineY != null && (
              <line
                x1="0"
                y1={geom.lineY}
                x2={W}
                y2={geom.lineY}
                stroke="rgba(139,144,153,0.65)"
                strokeWidth="1.2"
                strokeDasharray="6 5"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {geom.paths.map((run, i) => (
              <path key={`a${i}`} d={run.area} fill="url(#simpleFill)" />
            ))}
            {geom.paths.map((run, i) => (
              <path
                key={`l${i}`}
                d={run.d}
                fill="none"
                stroke={stroke}
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {geom.lineY != null && line != null && (
            <span
              className="pointer-events-none absolute left-2 -translate-y-1/2 rounded border border-(--line-soft) bg-bg-1/85 px-1.5 py-0.5 font-mono text-[10.5px] text-text-2 backdrop-blur"
              style={{ top: `${(geom.lineY / H) * 100}%` }}
            >
              LINE {price(line)}
            </span>
          )}
          {/* live tip — a solid dot with a breathing halo so it reads as a live ticker */}
          <span
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${(geom.dotX / W) * 100}%`, top: `${(geom.dotY / H) * 100}%` }}
          >
            <span
              className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ border: `1.5px solid ${stroke}`, animation: 'breathe 2.4s ease-in-out infinite' }}
            />
            <span
              className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ background: stroke, boxShadow: `0 0 12px ${stroke}` }}
            />
          </span>
        </>
      ) : (
        <div className="skeleton absolute inset-0 opacity-40" />
      )}
    </div>
  );
}
