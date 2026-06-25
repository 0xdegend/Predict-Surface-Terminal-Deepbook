/**
 * lib/analytics/vol-curves.ts — implied-vol analytics (Analytics Phase 3).
 *
 * The 2-D companion to the 3-D surface, derived from the same SVI math:
 *   1. TERM STRUCTURE — current ATM implied vol across every live expiry, so you
 *      can read the vol curve (contango vs backwardation) at a glance, and
 *   2. ATM-IV HISTORY — how one market's ATM vol has moved over time, replayed
 *      from its SVI + forward history exactly like the surface's time-travel.
 *
 * Pure + server-data-only. ATM IV is `impliedVol(forward, forward, svi, T)` —
 * the at-the-money point (k=0) of the smile this module already builds elsewhere.
 */
import { toFloat } from '@/config/scale';
import { impliedVol, parseSvi, timeToExpiryYears } from '@/lib/svi/svi';
import type { MarketCell } from '@/lib/analytics/market-grid';
import type { SviEvent, PriceEvent } from '@/lib/api/types';

/** One expiry on the term-structure curve. */
export interface TermPoint {
  oracleId: string;
  underlying: string;
  expiry: number; // ms
  tYears: number; // time to expiry
  atmIv: number; // ATM implied vol
  forward: number;
}

/**
 * Current ATM IV across the live markets, sorted by expiry (the natural ladder).
 * Reuses the market-grid cells (which already carry ATM IV + forward), so the
 * term structure costs nothing extra. Drops anything past expiry or non-finite.
 */
export function buildTermStructure(cells: MarketCell[], nowMs: number): TermPoint[] {
  return cells
    .map((c) => ({
      oracleId: c.oracleId,
      underlying: c.underlying,
      expiry: c.expiry,
      tYears: timeToExpiryYears(c.expiry, nowMs),
      atmIv: c.atmIv,
      forward: c.forward,
    }))
    .filter((p) => p.tYears > 0 && Number.isFinite(p.atmIv) && p.atmIv > 0)
    .sort((a, b) => a.expiry - b.expiry);
}

/** One sample on a market's ATM-IV history. */
export interface IvHistoryPoint {
  ts: number; // ms epoch
  atmIv: number;
}

/** Latest item at-or-before `t` in an ascending-by-timestamp array (mirrors the
 *  surface scrub's `snapshotAt`). */
function latestAtOrBefore<T extends { onchain_timestamp: number }>(arr: T[], t: number): T | null {
  let lo: T | null = null;
  for (const item of arr) {
    if (item.onchain_timestamp <= t) lo = item;
    else break;
  }
  return lo;
}

/**
 * Reconstruct a market's ATM IV over time from its SVI + price history. For each
 * SVI snapshot we read the forward in force at that instant and the time left to
 * expiry *then*, so the curve is historically honest (not back-cast with today's
 * T). Inputs may arrive newest-first from the server — we sort ascending here.
 */
export function reconstructAtmIvHistory(
  sviHistory: SviEvent[],
  priceHistory: PriceEvent[],
  expiry: number,
): IvHistoryPoint[] {
  const svi = [...sviHistory].sort((a, b) => a.onchain_timestamp - b.onchain_timestamp);
  const prices = [...priceHistory].sort((a, b) => a.onchain_timestamp - b.onchain_timestamp);

  const out: IvHistoryPoint[] = [];
  for (const e of svi) {
    const fwd = latestAtOrBefore(prices, e.onchain_timestamp);
    if (!fwd) continue;
    const tYears = timeToExpiryYears(expiry, e.onchain_timestamp);
    if (tYears <= 0) continue;
    const forward = toFloat(fwd.forward);
    const iv = impliedVol(forward, forward, parseSvi(e), tYears);
    if (Number.isFinite(iv) && iv > 0) out.push({ ts: e.onchain_timestamp, atmIv: iv });
  }
  return out;
}
