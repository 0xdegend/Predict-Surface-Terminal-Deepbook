/**
 * lib/insights/tenor.ts — how long a market has left, as a band the page can reason
 * about. The Options page's one answer to "1-day and 1-week markets are coming".
 *
 * WHY A BAND AND NOT A CADENCE. `V2Cadence` ('1m' | '5m' | '1h') classifies a market
 * by how it was CREATED — the rolling-window tenor baked into the event. That is the
 * right key for the pickers, the round tape and the market cards, which care which
 * product a market belongs to. It is the WRONG key here, for two reasons:
 *
 *   1. It is a closed enum. A 1-day market lands as '1h' today (the classifier's
 *      `tenorMs > 40min` branch), so every "is this a short market?" test would
 *      quietly answer wrong the day the new tenors ship, with no type error to catch
 *      it. Widening the enum means touching simple mode, the market cards, the round
 *      history and the share cards — a change that belongs to those screens, not to
 *      this one.
 *   2. It is fixed at creation, but what the page needs is TIME LEFT. An hourly
 *      market with 40 seconds on it should read like a flash market, because that is
 *      what it now is for anyone deciding a bet.
 *
 * So this measures `expiry − now` and buckets it. Continuous in, band out: 1d and 1w
 * markets fall into the right bucket the moment they exist, with no change here.
 *
 * The bands drive three real decisions, each of which is a live bug today waiting on
 * the new tenors:
 *
 *   • `outsideContext` — Deribit max pain, spot ETF flows and put/call by DATE are
 *     genuine reads on a 1-week market and meaningless against a 5-minute one. Today
 *     the page shows them at full weight regardless, and even prints a sentence that
 *     compares a monthly pin to our five-minute distribution.
 *   • `vegaMeaningful` — a binary's vega is ~0 at the money by construction, and on a
 *     minute-scale market it is ~0 everywhere worth trading. It only becomes a real
 *     number once there is enough time for the vol itself to move.
 *   • `realizedWindowMins` — the reality check hardcodes a 1-hour realized window. A
 *     1-week market wants a matching horizon, not an hour.
 *
 * Pure + side-effect free (CLAUDE.md §6.5): no clock of its own, no React, no fetch.
 * `now` is always injected, so this is deterministic and unit-tested.
 */

/** Bands, soonest first. Ordered, so `TENOR_ORDER.indexOf` gives a comparable rank. */
export type TenorBand = 'flash' | 'short' | 'hour' | 'day' | 'week';

export const TENOR_ORDER: TenorBand[] = ['flash', 'short', 'hour', 'day', 'week'];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Upper bound (exclusive) of each band in ms of time remaining. The cut points sit
 * BETWEEN the cadences rather than on them, so a market reads as its own band for
 * nearly all of its life and only crosses down as it genuinely runs out of time:
 *
 *   flash  < 3 min      a 1m market, or anything in its last moments
 *   short  < 30 min     a 5m market
 *   hour   < 6 h        a 1h market
 *   day    < 3 days     a 1d market  (not yet live)
 *   week   everything else           (not yet live)
 */
const UPPER: Record<Exclude<TenorBand, 'week'>, number> = {
  flash: 3 * MIN,
  short: 30 * MIN,
  hour: 6 * HOUR,
  day: 3 * DAY,
};

/** Plain-word name for a band, for copy that has to say which horizon it means. */
export const TENOR_LABEL: Record<TenorBand, string> = {
  flash: 'the next few minutes',
  short: 'the next half hour',
  hour: 'the next few hours',
  day: 'the next day or so',
  week: 'the week ahead',
};

/**
 * The band for a market with `msLeft` remaining. Non-positive (already expired) reads
 * as 'flash' rather than throwing: an expired market is the shortest thing there is,
 * and callers that care about expiry test it directly.
 */
export function tenorBandFromMsLeft(msLeft: number): TenorBand {
  if (!Number.isFinite(msLeft) || msLeft < UPPER.flash) return 'flash';
  if (msLeft < UPPER.short) return 'short';
  if (msLeft < UPPER.hour) return 'hour';
  if (msLeft < UPPER.day) return 'day';
  return 'week';
}

/** The band for a market expiring at `expiryMs`, judged against an injected clock. */
export function tenorBand(expiryMs: number, now: number): TenorBand {
  return tenorBandFromMsLeft(expiryMs - now);
}

/** True when `band` is at least as long-dated as `min`. */
export function atLeast(band: TenorBand, min: TenorBand): boolean {
  return TENOR_ORDER.indexOf(band) >= TENOR_ORDER.indexOf(min);
}

/**
 * How much weight the WIDER options market (Deribit max pain, put/call by date, spot
 * ETF net flow) deserves against a bet on this band.
 *
 *   'primary'   — same horizon. A max-pain pin genuinely pulls a 1-week bet, and a
 *                 day of ETF flow is a real input to a 1-day one.
 *   'backdrop'  — different horizon, still worth knowing. The regime a 1-hour bet
 *                 sits inside, labelled as backdrop rather than priced in.
 *   'unrelated' — a monthly pin says nothing about the next five minutes. Show it
 *                 only if the trader asks, and never in the same breath as our odds.
 */
export function outsideContext(band: TenorBand): 'primary' | 'backdrop' | 'unrelated' {
  if (atLeast(band, 'day')) return 'primary';
  if (band === 'hour') return 'backdrop';
  return 'unrelated';
}

/**
 * Whether vega is worth a tile on this band. A binary's vega is zero at the money by
 * construction (a symmetric bet neither gains nor loses from more movement), and on a
 * minute-scale market implied vol cannot move far enough for the off-ATM figure to
 * matter either. From an hour out it starts to be a real number.
 */
export function vegaMeaningful(band: TenorBand): boolean {
  return atLeast(band, 'hour');
}

/**
 * The realized-vol lookback that MATCHES a band, in minutes — what "priced vs what
 * actually happened" should compare against for a market of this length. Comparing a
 * 1-week bet to the last hour of tape would answer a question nobody asked.
 */
export function realizedWindowMins(band: TenorBand): number {
  switch (band) {
    case 'flash':
      return 5;
    case 'short':
      return 30;
    case 'hour':
      return 60;
    case 'day':
      return 24 * 60;
    case 'week':
      return 7 * 24 * 60;
  }
}

/**
 * Pick up to `perBand` markets from each band represented in `markets` — the seeding
 * rule for the Options page.
 *
 * The page needs at least two DISTINCT expiries to build a surface, and it wants them
 * spread across horizons rather than clustered. Seeding by cadence did that only
 * because the cadences happened to be the horizons; the day 1d markets land as '1h'
 * that stops being true. Banding by time left keeps the spread correct for any set of
 * tenors the protocol ever ships, including ones that do not exist yet.
 *
 * Input order is preserved within each band, so callers that pass soonest-first get
 * the soonest markets of each horizon back.
 */
export function pickAcrossTenors<T>(
  markets: T[],
  expiryOf: (m: T) => number,
  now: number,
  perBand = 2,
): T[] {
  const byBand = new Map<TenorBand, T[]>();
  for (const m of markets) {
    const band = tenorBand(expiryOf(m), now);
    const bucket = byBand.get(band);
    if (bucket) bucket.push(m);
    else byBand.set(band, [m]);
  }
  // Walk TENOR_ORDER rather than the map's insertion order, so the result is
  // deterministic regardless of how the caller sorted its input.
  return TENOR_ORDER.flatMap((b) => (byBand.get(b) ?? []).slice(0, perBand));
}
