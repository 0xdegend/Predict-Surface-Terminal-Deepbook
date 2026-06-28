/**
 * lib/markets/v2-discovery.ts — turn the raw `/markets` event stream into the set
 * of live, tradeable ExpiryMarkets, grouped by cadence.
 *
 * Cadence isn't in the event, so we derive it. Every market enters the rolling
 * window exactly `windowSize` periods before its expiry, so the creation tenor
 * (expiry − created) is ~constant per cadence: 1m≈3min, 5m≈15min, 1h≈3h. The 1h
 * cadence is also uniquely identifiable by its larger expiry allocation, which we
 * use as a robust tiebreak. Pure + deterministic.
 */
import type { V2Market } from '@/lib/api/v2/types';
import { toFloat } from '@/config/scale';

export type V2Cadence = '1m' | '5m' | '1h';

/** Wall-clock now, wrapped so callers (incl. dynamic Server Components) read time
 *  through a named util rather than an inline impure global. Prefer an indexer's
 *  `current_time_ms` when available; use this only as a fallback. */
export const wallClockMs = (): number => Date.now();

export const CADENCE_ORDER: V2Cadence[] = ['1m', '5m', '1h'];
export const CADENCE_LABEL: Record<V2Cadence, string> = {
  '1m': '1-minute',
  '5m': '5-minute',
  '1h': 'Hourly',
};

/** The 1h cadence's distinctive max expiry allocation (1e9 string). */
const HOURLY_ALLOCATION = '250000000000';

/** Classify a market into its cadence from creation tenor + allocation. */
export function cadenceOf(m: V2Market): V2Cadence {
  const tenorMs = m.expiry - m.checkpoint_timestamp_ms;
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

/** Group active markets by cadence, preserving soonest-first order within each. */
export function groupByCadence(markets: V2Market[]): Record<V2Cadence, V2Market[]> {
  const out: Record<V2Cadence, V2Market[]> = { '1m': [], '5m': [], '1h': [] };
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

/** Max leverage offered by a market, as a human multiple (e.g. 3 for 3x). */
export function maxLeverageX(m: V2Market): number {
  return toFloat(m.max_admission_leverage);
}
