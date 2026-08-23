/**
 * lib/insights/expiry-choice — which expiry the Options page opens on, and how an
 * expiry is named.
 *
 * The page used to open on `markets[0]`, and markets are sorted soonest-first, so a
 * visitor landed on whatever expires NEXT — often seconds away. At that horizon every
 * number on the page collapses into noise: the expected range reads ±0.02%, ladder
 * strikes sit $4 apart, the three consensus reads all print 50%, and "move needed"
 * rounds to -0.00%. The analysis is fine; there is simply nothing to analyse yet.
 *
 * So the landing expiry is the soonest one with enough life left to say something. An
 * explicit pick is never overridden — this only supplies the DEFAULT.
 */

/** Below this, an expiry is a settlement race rather than a market to read. */
export const READABLE_HORIZON_MS = 3 * 60_000;

/**
 * The expiry to open on: the soonest one at least `minMs` away, else the longest
 * available (a ladder of 30-second markets is still better than a blank page), else
 * null. Assumes `expiries` is sorted soonest-first, as the discovery layer returns.
 */
export function defaultExpiryId<T extends { marketId: string; expiryMs: number }>(
  expiries: T[],
  now: number,
  minMs: number = READABLE_HORIZON_MS,
): string | null {
  if (!expiries.length) return null;
  const readable = expiries.find((e) => e.expiryMs - now >= minMs);
  if (readable) return readable.marketId;
  return expiries.reduce((a, b) => (b.expiryMs > a.expiryMs ? b : a)).marketId;
}

/**
 * How long an expiry has left, in words a person uses: "45 sec", "11 min", "2 hr",
 * "1 day".
 *
 * Two things it must never do. It must not round a live market down to nothing — the
 * old label used `Math.round(ms / 60_000)`, so 45 seconds from settlement it read "0m",
 * a duration that means "already over". And it must not claim MORE time than there is,
 * which rounding also did: 2 minutes 40 seconds read "3 min", so a "3 min" market could
 * be under the threshold the landing rule uses and the two would visibly disagree.
 * Flooring fixes both, and matches how a clock counts down.
 */
export function expiryLabel(expiryMs: number, now: number): string {
  const ms = expiryMs - now;
  if (ms <= 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${Math.max(1, sec)} sec`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr`;
  return `${Math.floor(hr / 24)} day${Math.floor(hr / 24) === 1 ? '' : 's'}`;
}

/** The same duration with no space, for tight chips ("45s", "11m", "2h"). */
export function expiryLabelShort(expiryMs: number, now: number): string {
  return expiryLabel(expiryMs, now)
    .replace(/ sec$/, 's')
    .replace(/ min$/, 'm')
    .replace(/ hr$/, 'h')
    .replace(/ days?$/, 'd');
}
