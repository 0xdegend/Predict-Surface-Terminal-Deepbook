import { describe, it, expect } from 'vitest';
import { buildSurfaceMesh } from './mesh';
import type { Surface, SurfaceCell, SurfaceRow } from './surface';

/**
 * `ivRange` is the ONLY behaviour added to the mesh for time travel, and it is opt-in:
 * the live surface never passes it, so it must keep auto-ranging exactly as before.
 * These tests pin both halves of that contract.
 */
const cell = (kIndex: number, iv: number, tradeable = true): SurfaceCell => ({
  expiryIndex: 0,
  kIndex,
  k: (kIndex - 1) * 0.03,
  iv,
  w: iv * iv,
  up: tradeable ? 0.5 : 0.999,
  tradeable,
  butterfly: false,
  calendar: false,
});

const surfaceOf = (cells: SurfaceCell[]): Surface => {
  const r: SurfaceRow = { oracleId: 'm', expiry: 1_000, tYears: 0.001, forward: 64_000, cells };
  return { underlying: 'BTC', kGrid: cells.map((c) => c.k), rows: [r], hasCalendar: false, hasButterfly: false };
};

const s = surfaceOf([cell(0, 0.3), cell(1, 0.35), cell(2, 0.4)]);
const yOf = (m: ReturnType<typeof buildSurfaceMesh>, col: number) => m.positions[col * 3 + 1];

describe('buildSurfaceMesh — live (auto-range, unchanged)', () => {
  it('ranges over every cell and fits the surface to the display box', () => {
    const m = buildSurfaceMesh(s);
    expect(m.ivMin).toBeCloseTo(0.3, 6);
    expect(m.ivMax).toBeCloseTo(0.4, 6);
    // Auto-range always lifts the tallest cell to the top of the box — this is what
    // makes the live surface read at full drama, and it must stay that way.
    expect(yOf(m, 2)).toBeCloseTo(m.height, 6);
    expect(yOf(m, 0)).toBeCloseTo(0, 6);
  });

  it('still caps a degenerate outlier off the MEDIAN so it cannot hijack the scale', () => {
    // An expiring row's wings blow up (IV = √(w/T)); the median cap defuses them.
    const wild = surfaceOf([cell(0, 0.3), cell(1, 0.35), cell(2, 500)]);
    const m = buildSurfaceMesh(wild);
    expect(m.ivMax).toBeLessThan(2.01); // IV_DISPLAY_MAX ceiling, not 500
  });
});

describe('buildSurfaceMesh — ivRange (time travel only)', () => {
  it('uses the caller-pinned range instead of auto-fitting to this frame', () => {
    const m = buildSurfaceMesh(s, { ivRange: { min: 0.2, max: 0.6 } });
    expect(m.ivMin).toBeCloseTo(0.2, 6);
    expect(m.ivMax).toBeCloseTo(0.6, 6);
  });

  it('so a surface below the pinned ceiling renders BELOW full height — the point of pinning', () => {
    // Auto-ranged, the tallest cell ALWAYS fills the box, which is exactly what
    // normalized the vol level away while scrubbing (the surface looked rigid).
    expect(yOf(buildSurfaceMesh(s), 2)).toBeCloseTo(buildSurfaceMesh(s).height, 6);

    // Pinned, a 40% surface sits half-way up a 20–60% ruler, so it can visibly rise
    // and fall as you scrub.
    const pinned = buildSurfaceMesh(s, { ivRange: { min: 0.2, max: 0.6 } });
    expect(yOf(pinned, 2)).toBeCloseTo(pinned.height * 0.5, 6);
  });

  it('saturates (does not overshoot) a frame that exceeds the pinned ruler', () => {
    const pinned = buildSurfaceMesh(s, { ivRange: { min: 0.2, max: 0.35 } });
    expect(yOf(pinned, 2)).toBeCloseTo(pinned.height, 6); // 40% clamps to the ceiling
  });
});
