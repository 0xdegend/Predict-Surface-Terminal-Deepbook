/**
 * lib/markets/grouping.ts — organise active oracles for the beginner-friendly
 * card view. Pure + side-effect-free so it can be unit-tested.
 *
 * GROUPING MODEL — by time-to-expiry horizon (not by cadence). A non-crypto
 * native reasons in "how long until this resolves", so the cards read as one
 * unbroken countdown ladder: Closing soon → Within the hour → Next few hours →
 * Coming days → Weeks out. Markets march up the ladder as the clock ticks
 * (informative — a card visibly graduates toward settlement). Sorted within
 * each bucket by soonest expiry. Tune the thresholds in `HORIZONS`.
 *
 * CADENCE — kept only as a per-card TAG (`cadenceOf` → '15m' / '1h' / '1d'), so
 * a user can still see a market's native series. Live testnet (2026-06-04):
 * every expiry lands on a clean 15-minute grid; the protocol mints three
 * cadence series, distinguished by tenor (`expiry − activated_at`): ~2h → 15m,
 * ~5h → hourly, ≥ days → daily. NB the top-of-hour (:00) markets are the hourly
 * series, which is why grouping by cadence left a gap in the 15-min ladder —
 * horizon grouping fixes that.
 */
import type { Oracle } from '@/lib/api/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------ cadence (tag) ----------------------------- */

export type Cadence = '15m' | 'hourly' | 'daily';

const HOURLY_MAX_TENOR_MIN = 180; // < 3h  → quarter-hour intraday series
const DAILY_MAX_TENOR_MIN = 600; //  < 10h → top-of-hour series; else daily+

/** Stable cadence label from how far ahead the oracle was opened. */
export function cadenceOf(o: Oracle): Cadence {
  const tenorMin = (o.expiry - o.activated_at) / MIN;
  if (tenorMin < HOURLY_MAX_TENOR_MIN) return '15m';
  if (tenorMin < DAILY_MAX_TENOR_MIN) return 'hourly';
  return 'daily';
}

/** Compact per-card chip for the market's native cadence. */
export const CADENCE_TAG: Record<Cadence, string> = {
  '15m': '15m',
  hourly: '1h',
  daily: '1d',
};

/* ----------------------------- horizon (group) ---------------------------- */

export type Horizon = 'closing' | 'hour' | 'hours' | 'days' | 'weeks';

export interface HorizonMeta {
  label: string;
  blurb: string; // one-line plain-language explainer for non-crypto-natives
}

interface HorizonDef extends HorizonMeta {
  id: Horizon;
  /** Inclusive upper bound on time-to-expiry for this bucket. */
  maxMs: number;
}

/** Ordered soonest-first; the last bucket is the catch-all (maxMs = Infinity). */
export const HORIZONS: HorizonDef[] = [
  {
    id: 'closing',
    maxMs: 15 * MIN,
    label: 'Closing soon',
    blurb: 'Resolves in minutes — a quick call on where BTC lands next.',
  },
  {
    id: 'hour',
    maxMs: HOUR,
    label: 'Within the hour',
    blurb: 'Settles before the hour is out — a little room for the move.',
  },
  {
    id: 'hours',
    maxMs: 6 * HOUR,
    label: 'Next few hours',
    blurb: 'A few hours for your view to play out.',
  },
  {
    id: 'days',
    maxMs: 7 * DAY,
    label: 'Coming days',
    blurb: 'Settles over the next several days, at 08:00 UTC.',
  },
  {
    id: 'weeks',
    maxMs: Infinity,
    label: 'Weeks out',
    blurb: 'Longer-horizon markets, weeks ahead.',
  },
];

/** Which horizon bucket a given expiry falls into, relative to `now`. */
export function horizonOf(expiry: number, now: number): Horizon {
  const dt = expiry - now;
  for (const h of HORIZONS) if (dt <= h.maxMs) return h.id;
  return 'weeks';
}

export interface MarketGroup {
  horizon: Horizon;
  meta: HorizonMeta;
  oracles: Oracle[];
}

/**
 * Bucket the live oracles by time-to-expiry horizon, drop anything already
 * expired, and order both the groups (soonest horizon first) and the oracles
 * within each (soonest expiry first). Empty groups are omitted.
 */
export function groupOracles(oracles: Oracle[], now: number): MarketGroup[] {
  const byHorizon = new Map<Horizon, Oracle[]>();
  for (const o of oracles) {
    if (o.expiry <= now) continue; // expired → no longer tradeable
    const h = horizonOf(o.expiry, now);
    const list = byHorizon.get(h) ?? [];
    list.push(o);
    byHorizon.set(h, list);
  }

  return HORIZONS.flatMap(({ id, label, blurb }) => {
    const list = byHorizon.get(id);
    if (!list || list.length === 0) return [];
    list.sort((a, b) => a.expiry - b.expiry);
    return [{ horizon: id, meta: { label, blurb }, oracles: list }];
  });
}
