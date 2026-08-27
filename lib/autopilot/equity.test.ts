import { describe, it, expect } from 'vitest';
import { buildEquityCurve, curveGeometry, EMPTY_CURVE, type EquityTrade } from './equity';

const t = (at: number, pnlUsd: number, outcome: EquityTrade['outcome'] = pnlUsd >= 0 ? 'won' : 'lost'): EquityTrade => ({
  at,
  pnlUsd,
  outcome,
});

describe('buildEquityCurve', () => {
  it('is empty until something has actually settled', () => {
    expect(buildEquityCurve([])).toEqual(EMPTY_CURVE);
    expect(buildEquityCurve([t(1, 0, 'pending'), t(2, 0, 'pending')])).toEqual(EMPTY_CURVE);
  });

  it('starts on the baseline and adds each trade in the order it resolved', () => {
    const c = buildEquityCurve([t(30, -2), t(10, 5), t(20, 3)]);
    expect(c.points.map((p) => p.cum)).toEqual([0, 5, 8, 6]);
    expect(c.points[0].at).toBe(10);
    expect(c.net).toBe(6);
    expect(c.count).toBe(3);
  });

  it('leaves pending trades out rather than drawing them as break-evens', () => {
    const c = buildEquityCurve([t(10, 5), t(20, 0, 'pending'), t(30, -1)]);
    expect(c.count).toBe(2);
    expect(c.points.map((p) => p.cum)).toEqual([0, 5, 4]);
  });

  it('measures the worst fall from a peak, not the distance from zero', () => {
    // Up to +10, down to +2, back up: the drawdown is the 8 it gave back, even though
    // the line never went negative and the total finished ahead.
    const c = buildEquityCurve([t(1, 10), t(2, -8), t(3, 4)]);
    expect(c.peak).toBe(10);
    expect(c.trough).toBe(0);
    expect(c.maxDrawdown).toBe(8);
    expect(c.net).toBe(6);
  });

  it('counts a fall that starts before the line ever goes up', () => {
    const c = buildEquityCurve([t(1, -6), t(2, 2)]);
    expect(c.maxDrawdown).toBe(6);
    expect(c.trough).toBe(-6);
  });
});

describe('curveGeometry', () => {
  it('has nothing to draw with fewer than two points, or no room', () => {
    expect(curveGeometry(EMPTY_CURVE, 100, 40)).toBeNull();
    expect(curveGeometry(buildEquityCurve([t(1, 5)]), 0, 40)).toBeNull();
  });

  it('spans the full width and closes the area on the zero line', () => {
    const g = curveGeometry(buildEquityCurve([t(1, 5), t(2, 5)]), 100, 40)!;
    expect(g.line.startsWith('M 0.00')).toBe(true);
    expect(g.lastX).toBe(100);
    expect(g.area.endsWith(`L 0 ${g.zeroY.toFixed(2)} Z`)).toBe(true);
  });

  it('keeps zero inside the box even when the run never lost, so the line has a floor', () => {
    const g = curveGeometry(buildEquityCurve([t(1, 4), t(2, 4)]), 100, 40, 2)!;
    expect(g.zeroY).toBeCloseTo(38, 5); // the bottom of the box, not off it
    expect(g.lastY).toBeCloseTo(2, 5);
  });

  it('puts a flat line in the middle instead of dividing by a zero range', () => {
    const g = curveGeometry(buildEquityCurve([t(1, 3), t(2, -3)]), 100, 40)!;
    expect(Number.isFinite(g.lastY)).toBe(true);
    expect(g.lastY).toBeCloseTo(g.zeroY, 5);
  });
});
