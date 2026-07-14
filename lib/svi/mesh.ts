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
  /**
   * Pin the IV normalization window instead of auto-ranging to THIS frame's data.
   *
   * Auto-ranging re-fits the surface to fill the display box on every build. That's
   * right for a live surface (it always reads at full drama), but it is wrong for
   * time travel: it normalizes away the very thing you rewound to see. If the whole
   * vol level rises, an auto-ranged mesh just re-scales and looks identical — so the
   * surface appears to shift as a rigid block instead of actually rising. Pin the
   * range and the past is drawn on the SAME ruler as the present.
   */
  ivRange?: { min: number; max: number };
}

/* ── Surface display treatment (VISUAL ONLY) ──────────────────────────────────
 * These shape how DRAMATIC the surface reads; they never touch pricing, fair
 * values, or the arb checker (those use `w` / fair prices, not the mesh). Tune
 * freely — set (Infinity, 3) to restore the original raw-min/max, low-relief look. */
// IV used for color + height is capped at this multiple of the MEDIAN IV. Without
// it, a single row blowing up at expiry (IV = √(w/T) as T→0) stretches the scale
// so far that every live row pancakes onto the floor and the legend reads a
// nonsense "417,050%". Real data (wings ≲ 2× the median) never reaches the cap, so
// this only clips the degenerate artifact — the live surface is untouched.
const IV_DISPLAY_CAP_X_MEDIAN = 2.5;
// Vertical relief — IV maps into [0, RELIEF_HEIGHT]. Taller = bolder 3-D presence.
// This is the main "drama" knob; push it up for more standing height.
const RELIEF_HEIGHT = 4;
// Absolute IV display ceiling (fraction; 2.0 = 200%). Real BTC IV never gets near
// this, so it only ever clips the STRESS demo (and any T→0 artifact) — on
// ultra-short markets a no-arb-firing perturbation makes IV = √(w/T) explode into
// the thousands of %, and this keeps the legend + height sane instead of towering.
const IV_DISPLAY_MAX = 2.0;

export function buildSurfaceMesh(surface: Surface, opts: MeshOptions = {}): SurfaceMesh {
  const width = opts.width ?? 10;
  const depth = opts.depth ?? 6;
  const height = opts.height ?? RELIEF_HEIGHT;

  const rows = surface.rows.length;
  const cols = surface.kGrid.length;

  // IV range for color + height normalization. ivMax is capped at a multiple of
  // the MEDIAN IV so one degenerate row (an expiring oracle whose IV = √(w/T)
  // blows up as T→0) can't hijack the scale — that outlier would otherwise flatten
  // every live row onto the floor and drive the legend to "417,050%". The median
  // is robust to a whole outlier row, and clean data sits well under the cap, so
  // this leaves the real surface exactly as-is while defusing the artifact.
  let ivMin: number;
  let ivMax: number;
  if (opts.ivRange) {
    // Caller-pinned ruler (time travel ONLY) — see MeshOptions.ivRange. The live
    // surface never passes this and takes the auto-range path below, unchanged.
    ivMin = opts.ivRange.min;
    ivMax = opts.ivRange.max;
  } else {
    const ivs: number[] = [];
    for (const row of surface.rows) for (const c of row.cells) ivs.push(c.iv);
    ivs.sort((a, b) => a - b);
    ivMin = ivs.length ? ivs[0] : 0;
    ivMax = ivs.length ? ivs[ivs.length - 1] : 1;
    if (ivs.length) {
      const cap = ivs[Math.floor(ivs.length / 2)] * IV_DISPLAY_CAP_X_MEDIAN; // median × k
      if (Number.isFinite(cap) && cap > ivMin) ivMax = Math.min(ivMax, cap);
    }
    // Hard ceiling on top of the median cap — bounds the stress demo (and artifacts)
    // so the surface can't tower to thousands of %. Below it, nothing changes.
    ivMax = Math.min(ivMax, IV_DISPLAY_MAX);
  }
  if (!Number.isFinite(ivMin) || !Number.isFinite(ivMax) || ivMax <= ivMin) {
    ivMin = 0;
    ivMax = IV_DISPLAY_MAX;
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
      // Clamp: cells above the capped ivMax (the degenerate artifact) saturate at
      // the top of the ramp/height instead of overshooting.
      const tColor = Math.max(0, Math.min(1, (cell.iv - ivMin) / ivSpan));
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
