/**
 * lib/charts/simple-series.ts — the pure series maths behind SIMPLE mode's price
 * visuals: the big round chart and every round card's sparkline.
 *
 * Extracted so all of them draw the SAME line from the SAME rules. Every simple-mode
 * market is a round on one asset (BTC), so there is exactly one price history on the
 * screen — computing it once and handing it around means a screen full of sparklines
 * costs no more network, and no card can drift out of agreement with the hero chart.
 *
 * Three rules, all of them lessons the full chart already learned (see
 * [[app/_components/v2/price-chart]]):
 *   - ONE clock per point (Pyth publish time, checkpoint time only as a fallback) —
 *     the two are offset, so mixing them interleaves points and tears the line.
 *   - Decimate to one point per second — the feed's sub-second bid/ask jitter
 *     otherwise renders as a zig-zag and makes the vertical scale snap around.
 *   - BREAK across a real gap rather than drawing a straight line through it —
 *     bridging paints price action that never happened.
 *
 * Pure and side-effect free (no React, no network) so it unit-tests without a chain.
 * See [[simple-mode]].
 */
import { pythSpot } from '@/lib/api/v2/client';
import type { PythObservation } from '@/lib/api/v2/types';

export type SpotPoint = { t: number; p: number };

/**
 * A gap longer than this (seconds) breaks the line.
 *
 * Sized against OUR SAMPLING RATE, not the feed's publish rate — that distinction is
 * what the old 5s threshold got wrong. The feed does publish ~1/sec (a history walk
 * comes back with 100 points across 100 consecutive seconds, zero holes), but the
 * client only learns a second's price by asking for it, and one `latest` read costs
 * p50 ~420ms / p95 ~1.7s on a fast desktop connection. Measured against the running
 * app: polling at 250ms yields ~1.4 samples/sec with routine 3s gaps, and the 2s
 * background feeder gaps 2-3s constantly. So 5s was barely one slow request of
 * headroom, and on a phone — worse latency, occasional dropped request — the line
 * fractured into pieces several times a minute.
 *
 * 10s means "we asked repeatedly for over ten seconds and got nothing new", which is a
 * genuine stall rather than a slow round-trip. Real stalls (the frozen-history artifact
 * this whole module exists to prevent) are minutes wide and still break cleanly.
 *
 * Holes SHORTER than this are drawn through, so [[lib/hooks/use-spot-series]] heals
 * them from history first — the ticks exist, we just missed asking for them.
 */
export const GAP_BREAK_S = 10;

/** A single, consistent timestamp (ms) for an observation — see the header. */
export function obsMs(o: PythObservation): number | null {
  return o.source_timestamp_ms ?? o.checkpoint_timestamp_ms ?? null;
}

/**
 * Observations → ascending points, one per second (the second's LAST tick wins),
 * trimmed to the trailing `windowS`.
 */
export function toSpotPoints(obs: PythObservation[], windowS: number): SpotPoint[] {
  const bySec = new Map<number, number>();
  // Sort by full ms so, within a second, the chronologically last tick wins.
  for (const o of [...obs].sort((a, b) => (obsMs(a) ?? 0) - (obsMs(b) ?? 0))) {
    const ms = obsMs(o);
    const v = pythSpot(o);
    if (ms == null || v == null) continue;
    bySec.set(Math.floor(ms / 1000), v);
  }
  const all = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
  if (!all.length) return [];
  const cutoff = all[all.length - 1][0] - windowS;
  return all.filter(([t]) => t >= cutoff).map(([t, p]) => ({ t, p }));
}

/** The trailing `windowS` seconds of an already-built series (cheap re-slice). */
export function sliceWindow(points: SpotPoint[], windowS: number): SpotPoint[] {
  if (!points.length) return points;
  const cutoff = points[points.length - 1].t - windowS;
  const from = points.findIndex((p) => p.t >= cutoff);
  return from <= 0 ? points : points.slice(from);
}

/** Split the series wherever the feed actually went quiet, so each run draws on its own. */
export function toRuns(points: SpotPoint[]): SpotPoint[][] {
  const runs: SpotPoint[][] = [];
  let cur: SpotPoint[] = [];
  for (const pt of points) {
    if (cur.length && pt.t - cur[cur.length - 1].t > GAP_BREAK_S) {
      runs.push(cur);
      cur = [];
    }
    cur.push(pt);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Runs of two or more consecutive points — the only thing that can be drawn as a line.
 * A LONE leftover point is dropped: after a long absence the browser throttles the
 * background feed to ~1/min, and those strays would otherwise stretch a chart's axis
 * across two dead minutes to frame a stub of live data.
 */
export function drawableRuns(points: SpotPoint[]): SpotPoint[][] {
  return toRuns(points).filter((run) => run.length >= 2);
}

/**
 * Is there a hole of more than `gapS` seconds that is OLD enough to be worth backfilling?
 *
 * `edgeGuardS` excludes the live edge, because the event index trails live by ~7s — a
 * hole in the last few seconds cannot be healed by a history walk, so asking for one
 * would just burn a request and come back with the same hole. Everything behind that
 * edge is fully indexed, and the walk returns every second of it.
 */
export function hasGapBefore(points: SpotPoint[], gapS: number, edgeGuardS: number): boolean {
  if (points.length < 2) return false;
  const edge = points[points.length - 1].t - edgeGuardS;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t > edge) break;
    if (points[i].t - points[i - 1].t > gapS) return true;
  }
  return false;
}

/** A point placed on the chart's ORDINAL x-axis: `i` is its slot, not its time. */
export interface PlacedPoint {
  i: number;
  t: number;
  p: number;
}

/**
 * Lay the drawable runs out on an ORDINAL x-axis — one slot per point, plus a single
 * empty slot wherever the line breaks.
 *
 * This is the whole reason the simple chart used to fracture where the advanced one
 * never did, and the difference was never the data — both are built from the same polls
 * and have the same holes in them. It was the axis.
 *
 * The advanced chart draws through lightweight-charts, whose time scale is ORDINAL:
 * points sit at even spacing by index, so a second we failed to sample costs no
 * horizontal space at all. That is why it has to push an explicit whitespace point to
 * sever a line across a real stall (see `toSeries` in [[app/_components/v2/price-chart]])
 * — without one, nothing would look broken, because nothing leaves a gap by itself.
 *
 * The simple chart is hand-drawn SVG and mapped x from real elapsed time, so every
 * unsampled second became visible dead space, and a slow round-trip — routine on a
 * phone, measured at 2-3s even on a fast desktop connection — tore the line apart.
 * Placing points by slot instead makes the two charts behave identically.
 *
 * A break still costs ONE slot, the same width lightweight-charts gives its whitespace
 * point: enough to read as a discontinuity, not enough to hollow out the chart.
 */
export function layoutRuns(points: SpotPoint[]): { runs: PlacedPoint[][]; slots: number } {
  const out: PlacedPoint[][] = [];
  let i = 0;
  for (const run of drawableRuns(points)) {
    if (out.length) i += 1; // the empty slot that marks the break
    out.push(run.map((pt) => ({ i: i++, t: pt.t, p: pt.p })));
  }
  return { runs: out, slots: i };
}

/**
 * Monotone cubic Hermite (Fritsch-Carlson) path — the smooth, flowing curve the full
 * chart gets from lightweight-charts' `LineType.Curved`, but monotone-preserving, so
 * it can never overshoot a real data point and invent a high or low the market never
 * printed. Points must be ascending in x.
 */
export function curvePath(pts: { x: number; y: number }[]): string {
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
    // A sign change is a local extremum: flatten the tangent so the curve turns AT
    // the point rather than bulging past it.
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

export type Momentum = 'up' | 'down' | 'flat';

/**
 * Which way BTC is moving right now: the live value against the one from ~`lookbackS`
 * ago. Inside a small DEADBAND it reports 'flat' rather than picking a side — on a
 * quiet tape the difference between two ticks is noise, and without the band a
 * momentum tint strobes red/green several times a second. Callers render 'flat'
 * neutral, which is also what makes the deadband safe: it never has to guess.
 */
export function momentumOf(points: SpotPoint[], lookbackS = 30): Momentum {
  if (points.length < 2) return 'flat';
  const latest = points[points.length - 1];
  const refTime = latest.t - lookbackS;
  let ref = points[0];
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].t <= refTime) {
      ref = points[i];
      break;
    }
  }
  const delta = latest.p - ref.p;
  const dead = Math.max(3, ref.p * 0.00005); // ~0.005%, floored at $3
  if (delta > dead) return 'up';
  if (delta < -dead) return 'down';
  return 'flat';
}
