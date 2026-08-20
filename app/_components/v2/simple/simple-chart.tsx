'use client';

/**
 * SimpleRoundChart — the calm live price chart for simple mode: a live BTC line
 * with the round's LINE (strike) drawn as a dashed horizontal, tinted mint when
 * the price is above the line and coral when below, and a live pulsing dot at the
 * edge. Self-contained SVG (no lightweight-charts) fed by the SAME pyth history
 * cache the full chart uses, so it adds no extra network work.
 *
 * It FILLS its container (no fixed height) so it never leaves dead space in the
 * panel, and stretches via preserveAspectRatio="none"; strokes use
 * vector-effect="non-scaling-stroke" so they stay crisp, and the dot + "LINE"
 * label are HTML overlays positioned by viewBox percentage. The `above` tint is
 * passed in (from the pricer forward vs the line) so it always agrees with the
 * header's "above/below the line". See [[simple-mode]].
 *
 * The series is built the SAME way the full chart builds its own (see
 * [[app/_components/v2/price-chart]]): merge the rolling pyth-tape buffer, decimate
 * to one point per second, and BREAK the line across real feed gaps. Without those
 * three, the frozen one-shot history plus a single advancing live tick got drawn as
 * one long straight diagonal — see the notes on `SOURCES` and `GAP_BREAK_S` below.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { pythHistoryQueryOptions, pythSeedQueryOptions } from '@/lib/hooks/use-v2-pyth-history';
import { getPythTape } from '@/lib/store/pyth-tape';
import { predictV2Config } from '@/config/predict';
import { price } from '@/lib/format';
import type { PythObservation } from '@/lib/api/v2/types';

const PID = predictV2Config.asset.pythFeedId;
const UP = '#4dd6b0';
const DOWN = '#f0796b';
const W = 600;
const H = 240;
const PAD_Y = 20;

/**
 * A feed gap longer than this (seconds) BREAKS the line instead of drawing a
 * straight segment across the missing time — the same rule the full chart uses.
 * The feed publishes ~1/sec, so a multi-second hole is a real stall; bridging it
 * paints price action that never happened (a fake cliff or a fake plateau). 5s
 * clears normal 1-3s jitter so a healthy feed never fragments.
 */
const GAP_BREAK_S = 5;

/** Rolling window drawn, in seconds. Enough context for a 1-minute round without
 *  letting a stale left edge squash the live action into the right margin. */
const WINDOW_S = 120;

/** Floor for the vertical span, so a dead-flat tape doesn't magnify sub-dollar
 *  jitter into a fake rollercoaster (mirrors the full chart's autoscale floor). */
const MIN_SPAN_FRAC = 0.0002; // 0.02% of price (~$13 at $65k)
const MIN_SPAN_ABS = 4;

type Point = { t: number; p: number };

/**
 * A single, consistent timestamp (ms). Prefer Pyth's own publish time and only
 * fall back to the Sui-checkpoint time — the two are offset from each other, so
 * mixing them across the series makes points interleave and tears the line.
 */
function obsMs(o: PythObservation): number | null {
  return o.source_timestamp_ms ?? o.checkpoint_timestamp_ms ?? null;
}

/**
 * Observations → ascending points, ONE per second (last value in the second wins),
 * trimmed to the trailing WINDOW_S. Per-second decimation rejects the feed's
 * sub-second noise (bid/ask flip, multi-publisher jitter) that otherwise renders as
 * a jagged zig-zag and makes the vertical scale snap around.
 */
function toPoints(obs: PythObservation[]): Point[] {
  const bySec = new Map<number, number>();
  // Sort by full ms so, within a second, the chronologically LAST tick wins.
  for (const o of [...obs].sort((a, b) => (obsMs(a) ?? 0) - (obsMs(b) ?? 0))) {
    const ms = obsMs(o);
    const v = pythSpot(o);
    if (ms == null || v == null) continue;
    bySec.set(Math.floor(ms / 1000), v);
  }
  const all = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
  if (!all.length) return [];
  const cutoff = all[all.length - 1][0] - WINDOW_S;
  return all.filter(([t]) => t >= cutoff).map(([t, p]) => ({ t, p }));
}

/** Split the series wherever the feed actually went quiet, so each run draws as its
 *  own path and nothing is painted across the hole. */
function toSegments(points: Point[]): Point[][] {
  const segs: Point[][] = [];
  let cur: Point[] = [];
  for (const pt of points) {
    if (cur.length && pt.t - cur[cur.length - 1].t > GAP_BREAK_S) {
      segs.push(cur);
      cur = [];
    }
    cur.push(pt);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * Monotone cubic Hermite (Fritsch-Carlson) path — the smooth, flowing curve the
 * full chart gets from `LineType.Curved`, but monotone-preserving so it can never
 * overshoot a real data point and invent a high/low the market never printed.
 */
function curvePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return '';
  const f = (v: number) => v.toFixed(1);
  if (n === 2) return `M ${f(pts[0].x)} ${f(pts[0].y)} L ${f(pts[1].x)} ${f(pts[1].y)}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1e-6;
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // A sign change is a local extremum: flatten the tangent so the curve turns
    // AT the point rather than bulging past it.
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C ${f(pts[i].x + h)} ${f(pts[i].y + m[i] * h)}, ${f(pts[i + 1].x - h)} ${f(pts[i + 1].y - m[i + 1] * h)}, ${f(pts[i + 1].x)} ${f(pts[i + 1].y)}`;
  }
  return d;
}

export function SimpleRoundChart({ line, above }: { line: number | null; above: boolean }) {
  const seed = useQuery(pythSeedQueryOptions);
  const full = useQuery(pythHistoryQueryOptions);
  const latest = useQuery({ queryKey: qkV2.pythLatest, queryFn: () => getPythLatest(PID), refetchInterval: 1500 });

  /**
   * SOURCES — the walk result is a ONE-SHOT backfill (no periodic re-walk), so on its
   * own it freezes at mount while the live read keeps advancing. The rolling pyth-tape
   * buffer (fed by the screen's `usePythTapeFeed`) is what stays CURRENT, so merging it
   * closes that hole; `toPoints` dedupes per second, so overlapping sources are free.
   * Re-read each time the live tick lands (~1.5s), which is also what re-renders us.
   */
  const points = useMemo(() => {
    const history = full.data?.length ? full.data : (seed.data ?? []);
    return toPoints([...history, ...getPythTape(), ...(latest.data ? [latest.data] : [])]);
  }, [full.data, seed.data, latest.data]);

  const stroke = above ? UP : DOWN;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    // Only a run of two or more consecutive seconds can be drawn as a line. A LONE
    // leftover point is ignored outright — after a long absence Chrome throttles the
    // background feed to ~1/min, and those stray samples would otherwise stretch the
    // axis across two dead minutes to frame a stub of live data.
    const runs = toSegments(points).filter((seg) => seg.length >= 2);
    if (!runs.length) return null;
    const tip = points[points.length - 1];
    const framed = [...runs.flat(), tip]; // the live tip always stays in frame
    let lo = Math.min(...framed.map((p) => p.p));
    let hi = Math.max(...framed.map((p) => p.p));
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
    const t0 = runs[0][0].t;
    const t1 = tip.t;
    const dt = t1 - t0 || 1;
    const x = (t: number) => ((t - t0) / dt) * W;
    const y = (p: number) => PAD_Y + (1 - (p - lo) / range) * (H - 2 * PAD_Y);
    // One path (and one area) per unbroken run — a gap draws nothing at all.
    const paths = runs.map((seg) => {
      const pts = seg.map((pt) => ({ x: x(pt.t), y: y(pt.p) }));
      const d = curvePath(pts);
      return { d, area: `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z` };
    });
    const lineY = line != null ? y(line) : null;
    return { paths, lineY, dotX: x(t1), dotY: y(tip.p) };
  }, [points, line]);

  return (
    <div className="relative h-full min-h-55 w-full overflow-hidden rounded-xl border border-(--line-soft) bg-bg-1">
      {geom ? (
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
            {geom.paths.map((seg, i) => (
              <path key={`a${i}`} d={seg.area} fill="url(#simpleFill)" />
            ))}
            {geom.paths.map((seg, i) => (
              <path
                key={`l${i}`}
                d={seg.d}
                fill="none"
                stroke={stroke}
                strokeWidth="3.5"
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
