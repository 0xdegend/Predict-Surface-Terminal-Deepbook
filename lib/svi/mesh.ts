/**
 * lib/svi/mesh.ts — turn a Surface into BufferGeometry-ready arrays.
 *
 * Pure (no three.js import) so it's testable and cheap. Produces a regular grid
 * mesh: X = log-moneyness, Z = time-to-expiry (depth), Y = implied vol (height),
 * with per-vertex colors from the IV ramp (cool → warm — the app's only accent).
 *
 * Axes are normalized into a tidy display box so the camera framing is stable
 * regardless of the underlying's price scale or tenor.
 */
import type { Surface } from './surface';

export interface SurfaceMesh {
  positions: Float32Array; // xyz per vertex, length = rows*cols*3
  colors: Float32Array; // rgb per vertex
  indices: Uint32Array; // two triangles per quad
  rows: number; // expiries
  cols: number; // k-grid steps
  ivMin: number;
  ivMax: number;
  /** Per-row normalized depth (z) and the source expiry/T for labels. */
  rowMeta: { z: number; expiry: number; tYears: number; forward: number }[];
  /** Per-col normalized x and the source k for labels. */
  colMeta: { x: number; k: number }[];
  /** Which (row,col) cells violate no-arb, for overlay highlighting. */
  violations: { row: number; col: number; kind: 'butterfly' | 'calendar' }[];
  width: number; // display box X extent
  depth: number; // display box Z extent
  height: number; // display box Y extent (IV mapped into [0, height])
}

/** Cool→warm IV ramp. t in [0,1]. Returns [r,g,b] in 0..1. */
export function ivColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  // teal/blue (low IV) → green → amber → coral (high IV)
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.16, 0.5, 0.73]], // deep cyan-blue
    [0.35, [0.3, 0.78, 0.69]], // teal
    [0.6, [0.62, 0.8, 0.4]], // green-yellow
    [0.8, [0.95, 0.7, 0.32]], // amber
    [1.0, [0.94, 0.36, 0.31]], // coral
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (x <= t1) {
      const f = (x - t0) / (t1 - t0 || 1);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export interface MeshOptions {
  width?: number;
  depth?: number;
  height?: number;
}

export function buildSurfaceMesh(surface: Surface, opts: MeshOptions = {}): SurfaceMesh {
  const width = opts.width ?? 10;
  const depth = opts.depth ?? 6;
  const height = opts.height ?? 3;

  const rows = surface.rows.length;
  const cols = surface.kGrid.length;

  // IV range for color + height normalization.
  let ivMin = Infinity;
  let ivMax = -Infinity;
  for (const row of surface.rows) {
    for (const c of row.cells) {
      if (c.iv < ivMin) ivMin = c.iv;
      if (c.iv > ivMax) ivMax = c.iv;
    }
  }
  if (!Number.isFinite(ivMin)) {
    ivMin = 0;
    ivMax = 1;
  }
  const ivSpan = ivMax - ivMin || 1;

  const kMin = surface.kGrid[0];
  const kMax = surface.kGrid[cols - 1];
  const kSpan = kMax - kMin || 1;

  const colMeta = surface.kGrid.map((k) => ({
    x: ((k - kMin) / kSpan - 0.5) * width,
    k,
  }));
  const rowMeta = surface.rows.map((row, r) => ({
    z: (rows === 1 ? 0.5 : r / (rows - 1) - 0.5) * depth,
    expiry: row.expiry,
    tYears: row.tYears,
    forward: row.forward,
  }));

  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  const violations: SurfaceMesh['violations'] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = surface.rows[r].cells[c];
      const idx = (r * cols + c) * 3;
      const tColor = (cell.iv - ivMin) / ivSpan;
      positions[idx] = colMeta[c].x;
      positions[idx + 1] = tColor * height; // height by normalized IV
      positions[idx + 2] = rowMeta[r].z;
      // Dead zone (fair UP outside the 1%–99% mintable band) recedes into a
      // muted slate so the tradeable ridge is the only part that glows with IV
      // color — these nodes are also non-clickable (see surface-canvas `pick`).
      const [cr, cg, cb] = ivColor(tColor);
      if (cell.tradeable) {
        colors[idx] = cr;
        colors[idx + 1] = cg;
        colors[idx + 2] = cb;
      } else {
        const f = 0.78; // blend toward slate
        colors[idx] = cr + (0.12 - cr) * f;
        colors[idx + 1] = cg + (0.14 - cg) * f;
        colors[idx + 2] = cb + (0.17 - cb) * f;
      }
      if (cell.calendar) violations.push({ row: r, col: c, kind: 'calendar' });
      if (cell.butterfly) violations.push({ row: r, col: c, kind: 'butterfly' });
    }
  }

  // Two triangles per quad.
  const quads = (rows - 1) * (cols - 1);
  const indices = new Uint32Array(Math.max(quads, 0) * 6);
  let o = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c + 1;
      indices[o++] = a;
      indices[o++] = d;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = d;
      indices[o++] = e;
    }
  }

  return {
    positions,
    colors,
    indices,
    rows,
    cols,
    ivMin,
    ivMax,
    rowMeta,
    colMeta,
    violations,
    width,
    depth,
    height,
  };
}
