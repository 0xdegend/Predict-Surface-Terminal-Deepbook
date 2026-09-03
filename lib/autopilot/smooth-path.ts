/**
 * A smooth SVG path through a run of points that never overshoots them.
 *
 * Monotone cubic interpolation (Fritsch and Carlson, the same construction d3 calls
 * `curveMonotoneX`): between any two neighbours the curve stays inside their y range,
 * so a high never draws higher than the trade that made it and a drawdown never dips
 * below its own trough. A plain Catmull-Rom would ring past both, which on a P&L line
 * invents money that was never there. Pure and unit-free: the caller maps to pixels
 * first, and what comes back is the `d` attribute.
 */
export interface XY {
  x: number;
  y: number;
}

const sign = (v: number) => (v < 0 ? -1 : 1);

/** Tangent at the middle of three points: the smaller of the two secant slopes, in the
 *  direction they agree on, and zero where they disagree (a local peak or trough). */
function slope3(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number {
  const h0 = x1 - x0;
  const h1 = x2 - x1;
  const s0 = (y1 - y0) / (h0 || (h1 < 0 ? -0 : 0));
  const s1 = (y2 - y1) / (h1 || (h0 < 0 ? -0 : 0));
  const p = (s0 * h1 + s1 * h0) / (h1 + h0);
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

/** Tangent at an end point, given the tangent at its only neighbour. */
function slope2(x0: number, y0: number, x1: number, y1: number, t: number): number {
  const h = x1 - x0;
  return h ? ((3 * (y1 - y0)) / h - t) / 2 : t;
}

const f = (v: number) => (Math.round(v * 100) / 100).toString();

function bezier(x0: number, y0: number, x1: number, y1: number, t0: number, t1: number): string {
  const dx = (x1 - x0) / 3;
  return ` C ${f(x0 + dx)},${f(y0 + dx * t0)} ${f(x1 - dx)},${f(y1 - dx * t1)} ${f(x1)},${f(y1)}`;
}

export function monotonePath(points: readonly XY[]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M ${f(points[0].x)},${f(points[0].y)}`;
  let d = `M ${f(points[0].x)},${f(points[0].y)}`;
  if (n === 2) return `${d} L ${f(points[1].x)},${f(points[1].y)}`;
  let t0 = slope2(points[0].x, points[0].y, points[1].x, points[1].y, slope3(points[0].x, points[0].y, points[1].x, points[1].y, points[2].x, points[2].y));
  for (let i = 1; i < n - 1; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const t1 = slope3(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
    d += bezier(p0.x, p0.y, p1.x, p1.y, t0, t1);
    t0 = t1;
  }
  const p0 = points[n - 2];
  const p1 = points[n - 1];
  d += bezier(p0.x, p0.y, p1.x, p1.y, t0, slope2(p0.x, p0.y, p1.x, p1.y, t0));
  return d;
}

/**
 * Sample a cubic bezier segment's y at parameter u (0..1). Test helper, exported so the
 * no-overshoot guarantee can be checked numerically rather than trusted.
 */
export function bezierY(y0: number, c1: number, c2: number, y1: number, u: number): number {
  const v = 1 - u;
  return v * v * v * y0 + 3 * v * v * u * c1 + 3 * v * u * u * c2 + u * u * u * y1;
}
