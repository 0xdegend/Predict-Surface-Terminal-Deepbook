/**
 * lib/autopilot/equity.ts — every saved run as one line.
 *
 * The Results tab could tell you the total and the win rate, which are the two numbers
 * that say least about a trader: +$40 reads the same whether it arrived in a straight
 * line or after a drawdown that would have made you switch the thing off. The curve is
 * the part worth looking at, and it is the one view here that gets better the longer
 * Autopilot is used.
 *
 * Built per TRADE, not per run: a run is a container, not a data point, and settling
 * trades in the order they actually resolved is what makes the shape real.
 */

/** One settled trade, structurally — so this module does not import the store. */
export interface EquityTrade {
  at: number;
  pnlUsd: number;
  outcome: 'won' | 'lost' | 'pending';
}

export interface EquityPoint {
  /** Ms epoch of the trade that moved the line. */
  at: number;
  /** Running total after it. */
  cum: number;
}

export interface EquityCurve {
  points: EquityPoint[];
  /** Where the line finishes. 0 when there is nothing settled yet. */
  net: number;
  /** Highest and lowest the running total ever reached, baseline included. */
  peak: number;
  trough: number;
  /**
   * The worst peak-to-trough fall along the way, as a positive number.
   *
   * The one number here that a total cannot fake: it is how far underwater this went at
   * its worst, which is the question anyone deciding whether to leave a bot running is
   * actually asking.
   */
  maxDrawdown: number;
  /** How many settled trades are in the line. */
  count: number;
}

export const EMPTY_CURVE: EquityCurve = {
  points: [],
  net: 0,
  peak: 0,
  trough: 0,
  maxDrawdown: 0,
  count: 0,
};

/**
 * Cumulative realized PnL across every settled trade, oldest first.
 *
 * Pending trades are left out rather than counted as zero: they have not decided yet,
 * and a flat step for each one would make a run of unsettled bets look like a run of
 * break-evens. The line starts at zero, at the first trade's own time, so the baseline
 * is visible rather than implied.
 */
export function buildEquityCurve(trades: EquityTrade[]): EquityCurve {
  const settled = trades
    .filter((t) => t.outcome === 'won' || t.outcome === 'lost')
    .sort((a, b) => a.at - b.at);
  if (settled.length === 0) return EMPTY_CURVE;

  const points: EquityPoint[] = [{ at: settled[0].at, cum: 0 }];
  let cum = 0;
  let peak = 0;
  let trough = 0;
  let maxDrawdown = 0;
  for (const t of settled) {
    cum += t.pnlUsd;
    if (cum > peak) peak = cum;
    if (cum < trough) trough = cum;
    const dip = peak - cum;
    if (dip > maxDrawdown) maxDrawdown = dip;
    points.push({ at: t.at, cum });
  }
  return { points, net: cum, peak, trough, maxDrawdown, count: settled.length };
}

/**
 * The curve as an SVG path in a 0..width by 0..height box, plus where the zero line
 * falls in it. Kept here rather than in the component so the geometry is testable and
 * the drawing code stays about drawing.
 *
 * The vertical range always includes zero and is never degenerate: a run of pure wins
 * still gets a baseline to rise off, and a single flat point sits in the middle instead
 * of dividing by nothing.
 */
export function curveGeometry(
  curve: EquityCurve,
  width: number,
  height: number,
  pad = 2,
): { line: string; area: string; zeroY: number; lastX: number; lastY: number } | null {
  const n = curve.points.length;
  if (n < 2 || width <= 0 || height <= 0) return null;
  const top = Math.max(curve.peak, 0);
  const bottom = Math.min(curve.trough, 0);
  const range = top - bottom || 1;
  const inner = Math.max(1, height - pad * 2);
  const x = (i: number) => (i / (n - 1)) * width;
  const y = (v: number) => pad + (1 - (v - bottom) / range) * inner;

  let line = `M ${x(0).toFixed(2)} ${y(curve.points[0].cum).toFixed(2)}`;
  for (let i = 1; i < n; i++) line += ` L ${x(i).toFixed(2)} ${y(curve.points[i].cum).toFixed(2)}`;
  const zeroY = y(0);
  const area = `${line} L ${width.toFixed(2)} ${zeroY.toFixed(2)} L 0 ${zeroY.toFixed(2)} Z`;
  return { line, area, zeroY, lastX: x(n - 1), lastY: y(curve.points[n - 1].cum) };
}
