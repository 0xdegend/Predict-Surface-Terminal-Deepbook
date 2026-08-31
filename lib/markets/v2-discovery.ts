/**
 * lib/markets/v2-discovery.ts — turn the raw `/markets` event stream into the set
 * of live, tradeable ExpiryMarkets, grouped by cadence.
 *
 * Cadence isn't in the event, so we derive it. Every market enters the rolling window
 * exactly `windowSize` periods before its expiry, so the creation tenor (expiry − created)
 * is ~constant per cadence. Measured on 8-21, where windowSize is 2: 1m≈2min, 5m≈10min,
 * 1h≈2h, 1d≈48h, 1w≈336h. (It was 3 periods on the older deployments, hence 1m≈3min there;
 * the classifier's bounds are wide enough to cover both.)
 *
 * The larger expiry allocation used to identify the 1h cadence on its own. It no longer
 * can: 8-21's 1d and 1w cadences carry the same allocation, so it now only separates those
 * three from the 1m/5m pair, and tenor does the rest. See cadenceOf.
 *
 * Pure + deterministic.
 */
import type { V2Market } from '@/lib/api/v2/types';
import { toFloat } from '@/config/scale';
import { predictV2Config } from '@/config/predict';

export type V2Cadence = '1m' | '5m' | '1h' | '1d' | '1w';

/** Wall-clock now, wrapped so callers (incl. dynamic Server Components) read time
 *  through a named util rather than an inline impure global. Prefer an indexer's
 *  `current_time_ms` when available; use this only as a fallback. */
export const wallClockMs = (): number => Date.now();

export const CADENCE_ORDER: V2Cadence[] = ['1m', '5m', '1h', '1d', '1w'];
export const CADENCE_LABEL: Record<V2Cadence, string> = {
  '1m': '1-minute',
  '5m': '5-minute',
  '1h': 'Hourly',
  '1d': 'Daily',
  '1w': 'Weekly',
};

/** The max expiry allocation shared by the 1h, 1d and 1w cadences (1e9 string). It separates
 *  those three from the 1m/5m pair, but NOT from each other — on 8-21 all three carry
 *  250000000000 — so it cannot be the whole test any more. Tenor does the rest. */
const HOURLY_ALLOCATION = '250000000000';

/**
 * Upper bound (ms) on a cadence's CREATION tenor, i.e. `expiry - created`, which is
 * `windowSize` cadence periods rather than one.
 *
 * Measured against the live 8-21 board on 2026-08-31, where windowSize is 2:
 *
 *   1m    0.03h      5m    0.17h      1h    2.00h      1d   48.00h      1w   336.00h
 *
 * The bounds sit well clear of those, because windowSize is protocol config and can change
 * without warning: a 1h market at windowSize 3 is 3h, and must not start reading as daily.
 * One observed 1w market came in at 290h rather than 336h, so the daily bound has to be far
 * below a week rather than just above two days.
 */
const CADENCE_MAX_TENOR_MS = { hour: 12 * 3_600_000, day: 7 * 24 * 3_600_000 } as const;

/**
 * Classify a market into its cadence from creation tenor + allocation.
 *
 * The long branches come FIRST and are tenor-only. Before 8-21 every listed market settled
 * within the hour, so `tenorMs > 40min` meaning hourly was true by construction. On 8-21 it
 * is not: a 1-week market satisfies that test, and without these branches a bet settling
 * nine days out was labelled "Hourly" everywhere it appeared. The short-market logic below
 * is untouched, so nothing a trader already recognises moves.
 */
export function cadenceOf(m: V2Market): V2Cadence {
  const tenorMs = m.expiry - m.checkpoint_timestamp_ms;
  if (tenorMs > CADENCE_MAX_TENOR_MS.day) return '1w';
  if (tenorMs > CADENCE_MAX_TENOR_MS.hour) return '1d';
  if (m.max_expiry_allocation === HOURLY_ALLOCATION || tenorMs > 40 * 60_000) return '1h';
  return tenorMs < 4 * 60_000 ? '1m' : '5m';
}

/**
 * Live, tradeable markets: dedupe by id (keep the freshest event), drop expired
 * ones, sort soonest-first. `now` is injectable for tests.
 */
export function activeMarkets(markets: V2Market[], now: number = Date.now()): V2Market[] {
  const byId = new Map<string, V2Market>();
  for (const m of markets) {
    const prev = byId.get(m.expiry_market_id);
    if (!prev || m.checkpoint_timestamp_ms > prev.checkpoint_timestamp_ms) {
      byId.set(m.expiry_market_id, m);
    }
  }
  return [...byId.values()].filter((m) => m.expiry > now).sort((a, b) => a.expiry - b.expiry);
}

/**
 * The analytics window: live markets PLUS those that expired within `lookbackMs`.
 * A 1-minute market's bets would otherwise vanish from "recent activity" the
 * instant it settles (often seconds after the bet); this keeps them visible for
 * a bounded window. Deduped (freshest event wins), sorted newest-expiry-first so
 * a `.slice(0, cap)` keeps the most recent markets. `now` is injectable for tests.
 */
export function recentMarkets(markets: V2Market[], lookbackMs: number, now: number = Date.now()): V2Market[] {
  const byId = new Map<string, V2Market>();
  for (const m of markets) {
    const prev = byId.get(m.expiry_market_id);
    if (!prev || m.checkpoint_timestamp_ms > prev.checkpoint_timestamp_ms) {
      byId.set(m.expiry_market_id, m);
    }
  }
  const cutoff = now - lookbackMs;
  return [...byId.values()].filter((m) => m.expiry > cutoff).sort((a, b) => b.expiry - a.expiry);
}

/** Group active markets by cadence, preserving soonest-first order within each. */
export function groupByCadence(markets: V2Market[]): Record<V2Cadence, V2Market[]> {
  const out: Record<V2Cadence, V2Market[]> = { '1m': [], '5m': [], '1h': [], '1d': [], '1w': [] };
  for (const m of markets) out[cadenceOf(m)].push(m);
  return out;
}

/**
 * Mintable strike grid (floats) around a forward, snapped to the admission tick.
 * `half` strikes on each side of the at-the-money strike.
 */
export function strikeGrid(forward: number, admissionTickScaled: string, half = 4): number[] {
  const tick = toFloat(admissionTickScaled);
  if (tick <= 0) return [forward];
  const atm = Math.round(forward / tick) * tick;
  const out: number[] = [];
  for (let i = -half; i <= half; i++) out.push(atm + i * tick);
  return out;
}

/** The market's NOMINAL max leverage, as a human multiple (e.g. 3 for 3x). This is only
 *  the p→1 asymptote/ceiling — it is NOT what a trader can use on a short market (see
 *  usableMaxLeverageX). Prefer usableMaxLeverageX for anything user-facing. */
export function maxLeverageX(m: V2Market): number {
  return toFloat(m.max_admission_leverage);
}

/**
 * The max leverage a trader can ACTUALLY use on a market right now: the nominal cap, but
 * forced to 1× while the market sits inside the protocol's no-leverage window (leverage
 * unlocks only more than `noLeverageWindowMs` before expiry, ~60min on 8-06). Every
 * short-cadence market is inside that window, so the nominal 3× over-promises there — a
 * 1-minute market is really 1×. `now` is injected so this stays pure (no inline clock in
 * render). Mirrors the chain's own gate in `admittedLeverageCap729` (lib/sui/v2/quote).
 */
export function usableMaxLeverageX(m: V2Market, now: number): number {
  const window = predictV2Config.noLeverageWindowMs;
  if (window > 0 && m.expiry - now <= window) return 1;
  return maxLeverageX(m);
}

/**
 * Near-expiry warning thresholds, in seconds before `expiry`. Keyed by
 * cadence, NOT a fraction of `(expiry - checkpoint_timestamp_ms)` — that tenor
 * is `windowSize` (3) cadence periods, not one (see the file header), so a
 * duration-fraction formula would be off by ~3x. `closingSoon` shows a
 * caution; `tooCloseToExpiry` blocks minting outright (a tx can't land in
 * time).
 */
const EXPIRY_THRESHOLDS: Record<V2Cadence, { closingSoonSecs: number; tooCloseSecs: number }> = {
  '1m': { closingSoonSecs: 10, tooCloseSecs: 4 },
  '5m': { closingSoonSecs: 10, tooCloseSecs: 5 },
  '1h': { closingSoonSecs: 10, tooCloseSecs: 5 },
  // Same seconds for the long cadences, deliberately. These are about whether a transaction
  // can still LAND before settlement, which depends on block time, not on how long the market
  // has been running. A 1-week market in its last five seconds is exactly as unmintable as a
  // 1-minute one.
  '1d': { closingSoonSecs: 10, tooCloseSecs: 5 },
  '1w': { closingSoonSecs: 10, tooCloseSecs: 5 },
};

/*
 * WHY 10s AND NOT 5s. The caution renders only while `closingSoon && !tooCloseToExpiry`,
 * so its visible life is the gap BETWEEN the two numbers. At 5s that gap is one second on
 * 1m and zero on 5m/1h (their block also sits at 5s), i.e. the warning would quietly stop
 * existing on two of three cadences. 10s leaves a 5-6s window that ends exactly when
 * minting blocks, so the countdown reads 10s down to 5s and then hands over to
 * "Too close to expiry".
 *
 * The old per-cadence spread was the real complaint: an hourly market warned for a full
 * TWO MINUTES, which reads as alarm rather than information. Urgency is about the seconds
 * left to act, and that is the same regardless of how long the round ran, so all three
 * cadences now share one window.
 */

/** True once the market is inside its cadence's "closing soon" caution window. */
export function isClosingSoon(m: V2Market, now: number): boolean {
  const secsLeft = (m.expiry - now) / 1000;
  return secsLeft <= EXPIRY_THRESHOLDS[cadenceOf(m)].closingSoonSecs;
}

/** True once a mint can no longer safely land before expiry. */
export function isTooCloseToExpiry(m: V2Market, now: number): boolean {
  const secsLeft = (m.expiry - now) / 1000;
  return secsLeft <= EXPIRY_THRESHOLDS[cadenceOf(m)].tooCloseSecs;
}
