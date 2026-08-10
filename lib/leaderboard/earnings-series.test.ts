import { describe, it, expect } from 'vitest';
import { buildAccrualSeries, type AccrualEvent } from './earnings-series';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

describe('buildAccrualSeries', () => {
  it('returns empty for no accrual', () => {
    expect(buildAccrualSeries([], 100, NOW)).toEqual([]);
  });

  it('accumulates fees in time order and appends a trailing now point', () => {
    const acc: AccrualEvent[] = [
      { ts: NOW - 3 * HOUR, fee: 2 },
      { ts: NOW - 1 * HOUR, fee: 3 },
    ];
    // lifetime already equals the reconstructed total → no scaling.
    const s = buildAccrualSeries(acc, 5, NOW);
    expect(s.map((p) => p.y)).toEqual([2, 5, 5]); // cumulative, then flat to now
    expect(s[s.length - 1].label).toBe('now');
    expect(s[s.length - 1].x).toBe(NOW);
  });

  it('sorts out-of-order events before accumulating (cadence is monotonic)', () => {
    const acc: AccrualEvent[] = [
      { ts: NOW - 1 * HOUR, fee: 3 },
      { ts: NOW - 3 * HOUR, fee: 2 }, // earlier, given last
    ];
    const s = buildAccrualSeries(acc, 5, NOW);
    // first plotted point is the earliest trade
    expect(s[0].x).toBe(NOW - 3 * HOUR);
    expect(s[0].y).toBe(2);
    // strictly non-decreasing
    for (let i = 1; i < s.length; i++) expect(s[i].y).toBeGreaterThanOrEqual(s[i - 1].y);
  });

  it('anchors the endpoint to the authoritative lifetime, preserving shape', () => {
    const acc: AccrualEvent[] = [
      { ts: NOW - 2 * HOUR, fee: 1 },
      { ts: NOW - 1 * HOUR, fee: 3 },
    ]; // reconstructs to 4, but lifetime says 8 → scale x2
    const s = buildAccrualSeries(acc, 8, NOW);
    expect(s[0].y).toBeCloseTo(2); // 1 * 2
    expect(s[1].y).toBeCloseTo(8); // 4 * 2
    expect(s[s.length - 1].y).toBeCloseTo(8); // endpoint == lifetime
    // ratio between the two trade points is unchanged by scaling (shape preserved)
    expect(s[1].y / s[0].y).toBeCloseTo(4 / 1);
  });

  it('does not scale when lifetime is unknown (0) — shows reconstructed total', () => {
    const acc: AccrualEvent[] = [{ ts: NOW - HOUR, fee: 4 }];
    const s = buildAccrualSeries(acc, 0, NOW);
    expect(s[0].y).toBe(4);
    expect(s[s.length - 1].y).toBe(4); // trailing now holds the total, no collapse to 0
  });
});
