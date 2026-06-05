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
 * A binary is only mintable while its fair UP price is strictly inside the
 * protocol's quoting band — far-OTM/ITM strikes round to 0%/100% and the mint
 * aborts. Single source of truth shared by the surface (to dim/disable dead
 * nodes) and the trade ticket (to gate the quote). Mirrors the contract's
 * 1%–99% ask bound.
 */
export const FAIR_TRADE_MIN = 0.01;
export const FAIR_TRADE_MAX = 0.99;
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
  opts: { kMin?: number; kMax?: number; kSteps?: number; nowMs?: number } = {},
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

  let hasCalendar = false;
  let hasButterfly = false;
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
    // Butterfly: within a row, UP must be non-increasing in k (k ascending).
    for (let c = 0; c < cells.length - 1; c++) {
      if (cells[c].up < cells[c + 1].up - ARB_EPS) {
        cells[c].butterfly = true;
        hasButterfly = true;
      }
    }
    return {
      oracleId: input.oracle.oracle_id,
      expiry: input.oracle.expiry,
      tYears,
      forward: input.forward,
      cells,
    };
  });

  // Calendar: at each k, w must be non-decreasing as T increases.
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

/**
 * Stress perturbation for the demo (§6.4): tilt the smile so the no-arb checker
 * visibly fires. Pure — returns new params.
 *
 * These oracles are ultra-short-dated, so b is tiny (~1e-3) — far below Lee's
 * moment bound b·(1±ρ) ≤ 2. A multiplicative bump never reaches arb territory,
 * so we ADD slope: at amount=1, b≈3 with ρ≈-0.97 gives b·(1−ρ)≈5.9 ≫ 2, a hard
 * left-wing butterfly violation, and a sharp kink (σ→0) to make it pop.
 */
export function stressSvi(svi: SviFloat, amount = 1): SviFloat {
  return {
    a: Math.max(svi.a * (1 - 0.7 * amount), 1e-6),
    b: svi.b + 3 * amount,
    rho: Math.max(-0.97, Math.min(0.97, svi.rho - 0.5 * amount)),
    m: svi.m,
    sigma: Math.max(svi.sigma * (1 - 0.6 * amount), 1e-6),
  };
}
