/**
 * Simple-mode cadence presentation. One place for how each round length is LABELLED,
 * how long it runs, and how its card is drawn — kept out of the components so the
 * cadence toggle, the hero ticket and the round cards can never disagree.
 *
 * `sparkWindowS` is deliberately different per cadence. Every simple-mode round is a
 * bet on the same asset, so without it a row of round cards would be the same picture
 * three times; giving a 1-minute round a tight recent slice and an hourly round the
 * whole buffer makes each card show the horizon it's actually traded on. All of them
 * are capped by what the rolling tape holds (~150s), so nothing here claims history the
 * buffer doesn't have.
 */
import type { SimpleCadence } from '@/lib/markets/round-pick';

export interface CadenceMeta {
  /** Compact label for chips and cards. */
  short: string;
  /** Label for the cadence toggle. */
  label: string;
  /** Trailing window the card's sparkline draws. */
  sparkWindowS: number;
}

export const CADENCE_META: Record<SimpleCadence, CadenceMeta> = {
  '1m': { short: '1 min', label: '1 min', sparkWindowS: 60 },
  '5m': { short: '5 min', label: '5 min', sparkWindowS: 110 },
  '1h': { short: '1 hour', label: '1 hour', sparkWindowS: 150 },
};

export const CADENCE_TABS: { id: SimpleCadence; label: string }[] = [
  { id: '1m', label: CADENCE_META['1m'].label },
  { id: '5m', label: CADENCE_META['5m'].label },
  { id: '1h', label: CADENCE_META['1h'].label },
];

/**
 * A countdown: `m:ss`, rolling up to `h:mm:ss` once a round is an hour or more out.
 *
 * The hourly cadence enters its window ~3 HOURS before expiry, so minutes-only ran the
 * count past 60 and printed nonsense like "172:16" — a duration nobody reads as two
 * hours fifty-two.
 */
export function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
