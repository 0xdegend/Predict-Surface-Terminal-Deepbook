import { describe, it, expect } from 'vitest';
import { bezierY, monotonePath, type XY } from './smooth-path';

/** Pull every cubic segment's four y values (start, c1, c2, end) back out of the path. */
function segments(d: string): { y0: number; c1: number; c2: number; y1: number }[] {
  const m = d.match(/^M ([-\d.]+),([-\d.]+)/);
  if (!m) return [];
  let y0 = Number(m[2]);
  const out: { y0: number; c1: number; c2: number; y1: number }[] = [];
  for (const c of d.matchAll(/C [-\d.]+,([-\d.]+) [-\d.]+,([-\d.]+) [-\d.]+,([-\d.]+)/g)) {
    const seg = { y0, c1: Number(c[1]), c2: Number(c[2]), y1: Number(c[3]) };
    out.push(seg);
    y0 = seg.y1;
  }
  return out;
}

describe('monotonePath', () => {
  it('handles the degenerate sizes', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 1, y: 2 }])).toBe('M 1,2');
    expect(monotonePath([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe('M 0,0 L 10,5');
  });

  it('starts at the first point, passes through every point, and ends at the last', () => {
    const pts: XY[] = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 3 }, { x: 40, y: 12 }];
    const d = monotonePath(pts);
    expect(d.startsWith('M 0,0')).toBe(true);
    const segs = segments(d);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.y1)).toEqual([8, 3, 12]);
  });

  it('never overshoots: each segment stays inside its two endpoints', () => {
    // A jagged P&L: a spike, a crash, a slow climb. Catmull-Rom would ring past all of
    // them; monotone cubic must not draw a single sample outside [min, max] of the pair.
    const pts: XY[] = [
      { x: 0, y: 0 },
      { x: 5, y: 40 },
      { x: 6, y: 38 },
      { x: 30, y: -25 },
      { x: 31, y: -24 },
      { x: 60, y: 10 },
      { x: 100, y: 10 },
    ];
    for (const s of segments(monotonePath(pts))) {
      const lo = Math.min(s.y0, s.y1) - 1e-6;
      const hi = Math.max(s.y0, s.y1) + 1e-6;
      for (let u = 0; u <= 1; u += 0.05) {
        const y = bezierY(s.y0, s.c1, s.c2, s.y1, u);
        expect(y).toBeGreaterThanOrEqual(lo);
        expect(y).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('a flat run stays exactly flat', () => {
    const d = monotonePath([{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 20, y: 5 }, { x: 30, y: 5 }]);
    for (const s of segments(d)) {
      expect(s.c1).toBe(5);
      expect(s.c2).toBe(5);
      expect(s.y1).toBe(5);
    }
  });
});
