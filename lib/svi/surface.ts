/**
 * lib/svi/surface.ts — build smiles + the IV surface, and run the no-arb checks.
 *
 *  - A SMILE is one oracle (one expiry) sampled across its real strike grid window.
 *    Used for the 2D smile and the clickable surface nodes.
 *  - The SURFACE samples IV on a SHARED log-moneyness grid across expiries so the
 *    3D mesh columns align and the calendar check compares like-for-like.
 *
 * No-arb (§6.4):
 *  - Butterfly (one expiry): UP price must be non-increasing in strike. Flag any
 *    adjacent pair where UP rises with strike (equivalently range_fair < 0).
 *  - Calendar (across expiries): total variance w(k) must be non-decreasing in T
 *    at fixed k. Flag any k where w_{T2} < w_{T1} for T1 < T2.
 */
import {
  upFair,
  dnFair,
  impliedVol,
  totalVarianceAtK,
  logMoneyness,
  timeToExpiryYears,
  type SviFloat,
} from './svi';
import { strikeWindow } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import type { Oracle } from '@/lib/api/types';

/** Tiny tolerance so float noise doesn't trip the no-arb flags. */
const ARB_EPS = 1e-7;

/**
 * A binary is only worth surfacing while its fair UP price is strictly inside
 * this band — deep-OTM/ITM strikes round to 0%/100% and can't be priced. Single
 * source of truth shared by the surface (to dim/disable dead nodes) and the
 * trade ticket (to gate the quote).
 *
 * This is a *fair-price* pre-filter, deliberately wider than the contract's
 * ~1% ask floor: the real cost is `ask = fair + spread`, so strikes with a sub-1%
 * fair often still have an ask the contract will price once the spread is added.
 * Widening the band to 0.2%–99.8% lets those cheap far-OTM bets through to the
 * chain-authoritative devInspect quote, which is the true gate (read-only, no
 * funds at risk). Strikes the chain still won't price fall back to "can't quote".
 */
export const FAIR_TRADE_MIN = 0.002;
export const FAIR_TRADE_MAX = 0.998;
export function isTradeableFair(up: number): boolean {
  return up > FAIR_TRADE_MIN && up < FAIR_TRADE_MAX;
}

export interface SmilePoint {
  strikeScaled: bigint; // 1e9-scaled grid strike (for keys / minting)
  strike: number; // float price
  k: number; // log-moneyness
  iv: number; // implied vol (z-axis)
  up: number; // fair UP price
  dn: number; // fair DN price
  butterfly: boolean; // butterfly violation vs the NEXT-higher strike
}

export interface Smile {
  oracleId: string;
  underlying: string;
  expiry: number;
  tYears: number;
  forward: number;
  settlement: number | null;
  svi: SviFloat;
  points: SmilePoint[];
  hasButterfly: boolean;
}

export interface SmileInput {
  oracle: Oracle;
  svi: SviFloat;
  forward: number; // float
  settlement?: number | null;
}

/**
 * Build one smile across a centered window of the oracle's real strike grid.
 *
 * `spanK` controls how wide a log-moneyness band to cover (default ±8%). The
 * tradeable grid is $1 ticks, but a $40 window is microscopically flat — so we
 * derive a tick STRIDE that spans ±spanK with `half` points per side, every
 * sampled strike still landing exactly on the mintable grid.
 */
export function buildSmile(
  input: SmileInput,
  opts: { half?: number; stepTicks?: bigint; spanK?: number; nowMs?: number } = {},
): Smile {
  const { oracle, svi, forward } = input;
  const settlement = input.settlement ?? null;
  const nowMs = opts.nowMs ?? Date.now();
  const tYears = Math.max(timeToExpiryYears(oracle.expiry, nowMs), 0);

  const half = opts.half ?? 24;
  const center = BigInt(Math.round(forward * 1e9));
  let stepTicks = opts.stepTicks;
  if (stepTicks === undefined) {
    const spanK = opts.spanK ?? 0.08;
    const priceSpan = forward * (Math.exp(spanK) - Math.exp(-spanK)); // total $ width
    const totalTicks = priceSpan / toFloat(Number(oracle.tick_size));
    stepTicks = BigInt(Math.max(1, Math.round(totalTicks / (2 * half))));
  }
  const scaledStrikes = strikeWindow(oracle, center, half, stepTicks);

  const points: SmilePoint[] = scaledStrikes.map((s) => {
    const strike = toFloat(Number(s));
    return {
      strikeScaled: s,
      strike,
      k: logMoneyness(strike, forward),
      iv: impliedVol(strike, forward, svi, tYears),
      up: upFair(strike, forward, svi, settlement),
      dn: dnFair(strike, forward, svi, settlement),
      butterfly: false,
    };
  });

  // Butterfly: UP must be non-increasing in strike. Flag the left node of any
  // adjacent pair where UP rises.
  let hasButterfly = false;
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].up < points[i + 1].up - ARB_EPS) {
      points[i].butterfly = true;
      hasButterfly = true;
    }
  }

  return {
    oracleId: oracle.oracle_id,
    underlying: oracle.underlying_asset,
    expiry: oracle.expiry,
    tYears,
    forward,
    settlement,
    svi,
    points,
    hasButterfly,
  };
}

/* ------------------------------- surface ------------------------------- */

export interface SurfaceCell {
  expiryIndex: number;
  kIndex: number;
  k: number;
  iv: number;
  w: number; // total variance (for calendar check)
  up: number; // fair UP price at this (k, T) — for the butterfly check
  tradeable: boolean; // fair UP inside the 1%–99% quoting band → mintable node
  butterfly: boolean; // butterfly violation vs the next-higher k in the same row
  calendar: boolean; // calendar violation vs the previous (shorter-T) expiry at this k
}

export interface SurfaceRow {
  oracleId: string;
  expiry: number;
  tYears: number;
  forward: number;
  cells: SurfaceCell[];
}

export interface Surface {
  underlying: string;
  kGrid: number[]; // shared log-moneyness axis
  rows: SurfaceRow[]; // ascending in T
  hasCalendar: boolean;
  hasButterfly: boolean;
}

/**
 * Build the IV surface over a shared k-grid across all provided expiries (same
 * underlying). Rows are sorted ascending in time-to-expiry. Runs the calendar
 * no-arb check column-by-column.
 */
export function buildSurface(
  inputs: SmileInput[],
  opts: { kMin?: number; kMax?: number; kSteps?: number; nowMs?: number; stress?: boolean } = {},
): Surface {
  const nowMs = opts.nowMs ?? Date.now();
  const kMin = opts.kMin ?? -0.15;
  const kMax = opts.kMax ?? 0.15;
  const kSteps = opts.kSteps ?? 41;

  const kGrid: number[] = [];
  for (let i = 0; i < kSteps; i++) {
    kGrid.push(kMin + ((kMax - kMin) * i) / (kSteps - 1));
  }

  const sorted = [...inputs].sort((a, b) => a.oracle.expiry - b.oracle.expiry);
  const underlying = sorted[0]?.oracle.underlying_asset ?? '';

  const rows: SurfaceRow[] = sorted.map((input, expiryIndex) => {
    const tYears = Math.max(timeToExpiryYears(input.oracle.expiry, nowMs), 1e-9);
    const settlement = input.settlement ?? null;
    const cells: SurfaceCell[] = kGrid.map((k, kIndex) => {
      const w = totalVarianceAtK(k, input.svi);
      const iv = w > 0 ? Math.sqrt(w / tYears) : 0;
      // UP at this k: strike = forward * e^k.
      const up = upFair(input.forward * Math.exp(k), input.forward, input.svi, settlement);
      return { expiryIndex, kIndex, k, iv, w, up, tradeable: isTradeableFair(up), butterfly: false, calendar: false };
    });
    return {
      oracleId: input.oracle.oracle_id,
      expiry: input.oracle.expiry,
      tYears,
      forward: input.forward,
      cells,
    };
  });

  // Demo only: before the checks run, introduce ONE localized sample mispricing
  // (a gentle, smoothed kink + a genuine no-arb violation). This keeps the whole
  // surface at its true live IV scale — no global perturbation, which would send
  // IV = √(w/T) into the thousands of % on short tenors and pancake it into a
  // flat red plateau. The checks below then flag exactly the injected cells, and
  // the Arb Check overlay lights them up.
  if (opts.stress) injectStressArb(rows, kGrid);

  // Butterfly: within a row, UP must be non-increasing in k (k ascending). Flag
  // the left node of any adjacent pair where UP rises.
  let hasButterfly = false;
  for (const row of rows) {
    for (let c = 0; c < row.cells.length - 1; c++) {
      if (row.cells[c].up < row.cells[c + 1].up - ARB_EPS) {
        row.cells[c].butterfly = true;
        hasButterfly = true;
      }
    }
  }

  // Calendar: at each k, w must be non-decreasing as T increases.
  let hasCalendar = false;
  for (let r = 1; r < rows.length; r++) {
    for (let c = 0; c < kGrid.length; c++) {
      if (rows[r].cells[c].w < rows[r - 1].cells[c].w - ARB_EPS) {
        rows[r].cells[c].calendar = true;
        hasCalendar = true;
      }
    }
  }

  return { underlying, kGrid, rows, hasCalendar, hasButterfly };
}

/** Smooth raised-cosine (Hann) weight: 1 at the center, easing to 0 at ±R. */
function hann(d: number, R: number): number {
  if (Math.abs(d) >= R) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / R));
}

/** Index of the k-grid column whose k is closest to `target`. */
function nearestK(kGrid: number[], target: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < kGrid.length; i++) {
    const d = Math.abs(kGrid[i] - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Demo-only STRESS (§6.4). The surface stays at its true, live IV scale — we do
 * NOT globally perturb the SVI (that explodes IV = √(w/T) into the thousands of
 * % on these ultra-short markets and pancakes everything into a flat red
 * plateau at the display ceiling). Instead we seed several *localized* sample
 * mispricings — broad, legacy-style red bands, but each confined to a wing on a
 * few expiries so most of the surface still looks live:
 *
 *   • Butterfly: contiguous bands across BOTH wings on a few expiries, where UP
 *     is made to climb with strike (it must be non-increasing).
 *   • Calendar: bands on the last two expiries, each pulled below the one in
 *     front (total variance must be non-decreasing in T).
 *
 * The flags ride on `up` / `w`, which don't drive the mesh height, so the
 * geometry only gets gentle Hann-smoothed swells/dips — the "arb" is shown by
 * the red overlay lighting up those bands, not by deforming the whole surface.
 * Bands stay on the glowing tradeable ridge (|k| ≲ 0.035), off the dead zone.
 */
function injectStressArb(rows: SurfaceRow[], kGrid: number[]): void {
  const n = rows.length;
  if (n === 0 || kGrid.length < 6) return;
  const AMP = 0.06; // gentle ±6% IV swell/dip — a hint, never a spike
  const inRange = (i: number) => i >= 0 && i < n;

  // A soft Hann-windowed IV swell (sign +1) or dip (sign −1) across [from, to].
  const bandSwell = (row: SurfaceRow, from: number, to: number, sign: number) => {
    const mid = (from + to) / 2;
    const half = Math.max((to - from) / 2, 1) + 2;
    for (let c = from - 2; c <= to + 2; c++) {
      if (c < 0 || c >= row.cells.length) continue;
      row.cells[c].iv *= 1 + sign * AMP * hann(c - mid, half);
    }
  };

  // Butterfly band on one expiry: UP climbs across [from, to] → every adjacent
  // pair violates. UP isn't a height, so only the overlay changes, not the mesh.
  const butterflyBand = (row: SurfaceRow, from: number, to: number) => {
    if (to <= from) return;
    bandSwell(row, from, to, +1);
    for (let c = from + 1; c <= to && c < row.cells.length; c++) {
      row.cells[c].up = Math.min(0.985, row.cells[c - 1].up + 0.005);
    }
  };

  // Calendar band on one expiry: total variance pulled below the expiry in front
  // across [from, to]. Read `prev` AFTER it may have been dipped too, so stacking
  // consecutive back rows keeps each below the last.
  const calendarBand = (row: SurfaceRow, prev: SurfaceRow, from: number, to: number) => {
    if (to <= from) return;
    bandSwell(row, from, to, -1);
    for (let c = from; c <= to && c < row.cells.length; c++) {
      if (c < 0) continue;
      row.cells[c].w = prev.cells[c].w * 0.9;
    }
  };

  const midIdx = Math.floor(n / 2);

  // ── Butterfly: right wing on a mid group of expiries ──
  const rb0 = nearestK(kGrid, 0.006);
  const rb1 = nearestK(kGrid, 0.034);
  for (const ri of [midIdx - 1, midIdx, midIdx + 1]) {
    if (inRange(ri)) butterflyBand(rows[ri], rb0, rb1);
  }

  // ── Butterfly: left wing on an earlier group of expiries ──
  const lb0 = nearestK(kGrid, -0.03);
  const lb1 = nearestK(kGrid, -0.006);
  const lStart = Math.max(1, midIdx - 3);
  for (const ri of [lStart, lStart + 1]) {
    if (inRange(ri)) butterflyBand(rows[ri], lb0, lb1);
  }

  // ── Calendar: a central band on the last two expiries ──
  const cb0 = nearestK(kGrid, -0.022);
  const cb1 = nearestK(kGrid, 0.022);
  for (const ri of [n - 2, n - 1]) {
    if (ri >= 1 && inRange(ri)) calendarBand(rows[ri], rows[ri - 1], cb0, cb1);
  }
}

/**
 * Stress perturbation for the demo (§6.4): tilt the smile so the no-arb checker
 * visibly fires. Pure — returns new params.
 *
 * These oracles are ultra-short-dated, so b is tiny (~1e-3) — far below Lee's
 * moment bound b·(1±ρ) ≤ 2. A multiplicative bump never reaches arb territory, so
 * we ADD slope. We only need to CLEAR the bound, not blow past it: at amount=1,
 * b≈2 with the ρ push gives b·(1−ρ) ≈ 3.2 (> 2) — a clear left-wing butterfly
 * violation with comfortable margin — while keeping the smile far gentler than the
 * old b+3 kink, which sent IV = √(w/T) into the thousands of % on 10-minute
 * markets. The display ceiling (mesh.ts IV_DISPLAY_MAX) bounds whatever remains.
 */
export function stressSvi(svi: SviFloat, amount = 1): SviFloat {
  return {
    a: Math.max(svi.a * (1 - 0.5 * amount), 1e-6),
    b: svi.b + 2 * amount,
    rho: Math.max(-0.97, Math.min(0.97, svi.rho - 0.5 * amount)),
    m: svi.m,
    sigma: Math.max(svi.sigma * (1 - 0.3 * amount), 1e-6),
  };
}
