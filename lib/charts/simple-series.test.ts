import { describe, it, expect } from 'vitest';
import { GAP_BREAK_S, drawableRuns, hasGapBefore, toRuns, type SpotPoint } from './simple-series';

/** A run of consecutive per-second points starting at `t0`. */
function run(t0: number, n: number, p = 70_000): SpotPoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i, p: p + i }));
}

describe('GAP_BREAK_S', () => {
  it('has headroom over the sampling jitter that fractured the mobile chart', () => {
    // Measured against the running app: polling `latest` at 250ms still only yields
    // ~1.4 samples/sec (p95 round-trip ~1.7s), leaving routine 3s holes; the 2s
    // background feeder gaps 2-3s constantly. A phone adds a slow request on top.
    expect(GAP_BREAK_S).toBeGreaterThan(3 * 2);
  });

  it('still breaks a real stall', () => {
    // The artifact this module exists to prevent: frozen history + one live tick.
    const pts = [...run(0, 20), { t: 200, p: 71_000 }];
    expect(toRuns(pts)).toHaveLength(2);
  });
});

describe('toRuns', () => {
  it('keeps ordinary poll jitter on one unbroken line', () => {
    const pts: SpotPoint[] = [
      { t: 0, p: 70_000 },
      { t: 3, p: 70_010 }, // a slow round-trip
      { t: 6, p: 70_020 }, // and another
      { t: 9, p: 70_030 },
    ];
    expect(toRuns(pts)).toHaveLength(1);
  });

  it('breaks once the feed goes quiet for longer than the threshold', () => {
    const pts = [...run(0, 5), ...run(5 + GAP_BREAK_S + 1, 5)];
    const runs = toRuns(pts);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(5);
    expect(runs[1]).toHaveLength(5);
  });
});

describe('drawableRuns', () => {
  it('drops a stranded single point rather than stretching the axis to frame it', () => {
    const pts = [{ t: 0, p: 70_000 }, ...run(500, 4)];
    const runs = drawableRuns(pts);
    expect(runs).toHaveLength(1);
    expect(runs[0][0].t).toBe(500);
  });
});

describe('hasGapBefore', () => {
  const GAP = 5;
  const EDGE = 12;

  it('is quiet on a dense series', () => {
    expect(hasGapBefore(run(0, 60), GAP, EDGE)).toBe(false);
  });

  it('is quiet on ordinary 2-3s sampling jitter, so it never re-walks forever', () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ t: i * 3, p: 70_000 + i }));
    expect(hasGapBefore(pts, GAP, EDGE)).toBe(false);
  });

  it('flags a settled hole that history can actually backfill', () => {
    const pts = [...run(0, 10), ...run(30, 30)]; // 20s hole, well behind the live edge
    expect(hasGapBefore(pts, GAP, EDGE)).toBe(true);
  });

  it('ignores a hole at the live edge — the event index trails live, so a walk cannot heal it', () => {
    const pts = [...run(0, 30), { t: 40, p: 70_100 }, { t: 41, p: 70_101 }];
    expect(hasGapBefore(pts, GAP, EDGE)).toBe(false);
  });

  it('needs two points to say anything', () => {
    expect(hasGapBefore([], GAP, EDGE)).toBe(false);
    expect(hasGapBefore([{ t: 0, p: 70_000 }], GAP, EDGE)).toBe(false);
  });
});
