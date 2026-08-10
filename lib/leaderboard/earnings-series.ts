/**
 * lib/leaderboard/earnings-series.ts — turn a per-trade builder-fee accrual timeline
 * into the admin chart's cumulative "lifetime earned" curve.
 *
 * The point of this over a cumulative CLAIM log is cadence: claims are sparse sweeps, so
 * their cumulative line is a straight ramp that implies we earn the same every day. The
 * accrual timeline is one point per attributed trade, so the curve is flat while the book
 * is quiet and steep while it's busy — the real shape.
 *
 * The SHAPE comes from the trades; the MAGNITUDE is anchored to the authoritative lifetime
 * (claimed + unclaimed from the code object) so the curve's endpoint always matches the KPI
 * even if the reconstruction misses a trade. Pure + deterministic (pass `nowMs`).
 */

/** One accrued builder-fee event: a trade's fee (float DUSDC) at its timestamp. */
export interface AccrualEvent {
  ts: number;
  fee: number;
}

/** A chart point (structurally the LineChart's ChartPoint). */
export interface SeriesPoint {
  x: number;
  y: number;
  label: string;
}

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Cumulative fees earned over time. Each trade steps the running total up by its fee;
 * the whole curve is then scaled so its final value equals `lifetime` (the authoritative
 * claimed + unclaimed), and a trailing "now" point holds that total flat from the last
 * trade to the present. Returns `[]` for no accrual (caller shows an empty state).
 */
export function buildAccrualSeries(
  accrual: AccrualEvent[],
  lifetime: number,
  nowMs: number,
): SeriesPoint[] {
  if (accrual.length === 0) return [];

  const sorted = [...accrual].sort((a, b) => a.ts - b.ts);
  let cum = 0;
  const raw = sorted.map((a) => ({ x: a.ts, y: (cum += a.fee) }));
  const total = cum;

  // Anchor magnitude to the authoritative lifetime; keep the shape. `scale === 1` when
  // the reconstruction already sums to lifetime (the common case), so values stay exact.
  const scale = total > 0 && lifetime > 0 ? lifetime / total : 1;
  const pts: SeriesPoint[] = raw.map((p) => ({ x: p.x, y: p.y * scale, label: fmtDay(p.x) }));

  const lastY = pts[pts.length - 1].y;
  pts.push({ x: nowMs, y: Math.max(lastY, lifetime), label: 'now' });
  return pts;
}
