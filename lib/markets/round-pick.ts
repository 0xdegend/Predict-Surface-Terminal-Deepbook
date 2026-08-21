/**
 * lib/markets/round-pick — which round each simple-mode tab shows.
 *
 * The tabs say "1 min", "5 min", "1 hour". A trader reads those as HOW LONG UNTIL I FIND
 * OUT. So that is what they now select on: a round's time remaining, not which series it
 * was created by.
 *
 * The old rule picked the soonest market of the matching SERIES, on the assumption that
 * the soonest is always inside its own period. Measured against the live chain over 20
 * samples, that assumption is simply false:
 *
 *   1m: exceeded its label  5/20 (25%)
 *   5m: exceeded its label  0/20
 *   1h: exceeded its label 20/20 (100%)  — always ~2h40m out, never within an hour
 *
 * The 1-minute series does not reliably keep a rung in every minute. Watching the ladder:
 * `1m[0:11 2:11]` — no rung at 1:11 — and once 0:11 expired the soonest was 1:58. That is
 * how the "1 min" tab ended up counting down from 1:41 while the "5 min" card sat at 0:41.
 * The hourly series is worse: it is created ~3h ahead and there is only ever one, so its
 * label was wrong every single time.
 *
 * Selecting by horizon fixes both, and by construction can never invert or overrun: a tab
 * shows a round from its own band or nothing at all. The bands are disjoint, so the hero
 * and the cards can never land on the same market either — something the old rule needed
 * an explicit guard for.
 *
 * WHY THE LONGEST IN BAND, not the soonest: the "5 min" tab picking a round with 1:12 left
 * is technically within its label but isn't what the label offers. Taking the longest that
 * still fits means each tab gives roughly the wait it advertises.
 *
 * WHY STICKY: the longest-in-band round changes the moment a further-out round crosses
 * into the band, which would make a countdown jump BACKWARDS mid-round. So a pick is held
 * until it expires or leaves the band, and only then re-chosen.
 */
import type { V2Cadence } from '@/lib/markets/v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';

/** Upper bound (ms) of each tab's band. The lower bound is the previous tab's upper. */
export const HORIZON_MS: Record<V2Cadence, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
};

/** Bands in order, as [lower exclusive, upper inclusive]. */
export const HORIZON_BAND: Record<V2Cadence, [number, number]> = {
  '1m': [0, HORIZON_MS['1m']],
  '5m': [HORIZON_MS['1m'], HORIZON_MS['5m']],
  '1h': [HORIZON_MS['5m'], HORIZON_MS['1h']],
};

export type HeldPicks = Partial<Record<V2Cadence, string>>;

/** Live markets whose time remaining falls in this tab's band, longest first. */
export function bandCandidates(markets: V2Market[], cadence: V2Cadence, now: number): V2Market[] {
  const [lo, hi] = HORIZON_BAND[cadence];
  return markets
    .filter((m) => {
      const left = m.expiry - now;
      return left > lo && left <= hi;
    })
    .sort((a, b) => b.expiry - a.expiry);
}

/**
 * The round for one tab: whatever is already held if it still qualifies, otherwise the
 * longest-running round that fits the band. Null when the band is genuinely empty — the
 * caller says so plainly rather than reaching outside the band, because a tab showing a
 * round longer than its own label is the whole bug this replaces.
 */
export function pickRound(
  markets: V2Market[],
  cadence: V2Cadence,
  now: number,
  heldId?: string,
): V2Market | null {
  const candidates = bandCandidates(markets, cadence, now);
  if (!candidates.length) return null;
  const held = heldId ? candidates.find((m) => m.expiry_market_id === heldId) : undefined;
  return held ?? candidates[0];
}

/** Every tab's round in one pass, so the hero and the cards agree by construction. */
export function pickAllRounds(
  markets: V2Market[],
  now: number,
  held: HeldPicks,
): Record<V2Cadence, V2Market | null> {
  return {
    '1m': pickRound(markets, '1m', now, held['1m']),
    '5m': pickRound(markets, '5m', now, held['5m']),
    '1h': pickRound(markets, '1h', now, held['1h']),
  };
}

/** A round together with the band it is being offered under. */
export interface BandRound {
  cadence: V2Cadence;
  market: V2Market;
}

/**
 * Every OTHER round a trader can bet right now, beyond the one in the hero.
 *
 * The screen used to offer exactly one round per tab, so a trader saw three of the six
 * or seven markets that are live at any moment. A census of the ladder on 2026-08-21:
 *
 *   1m[0:59]  5m[4:59 2:59 1:59]  1h[14:59 9:59]     total live = 7
 *   1m[0:39]  5m[2:39 1:39]       1h[10:39 5:39]     total live = 6
 *
 * The extra rungs are real, tradeable markets; they were being hidden by the one-per-tab
 * rule, not by anything about the protocol. This returns all of them.
 *
 * THE LABEL GUARANTEE SURVIVES because these still come out of `bandCandidates`: a round
 * is only ever offered under a band whose upper bound it is inside, so a card marked
 * "5 min" cannot show 6 minutes and a card marked "1 hour" cannot show more than an hour.
 * That holds no matter how many are shown, which is what makes offering extras safe.
 *
 * Ordered SOONEST FIRST: the row is a queue of what resolves next, which is the order a
 * trader scans it in. Band order would put a 15-minute round above a 40-second one.
 */
export function otherBandRounds(
  markets: V2Market[],
  now: number,
  heroId: string | null | undefined,
  max: number,
): BandRound[] {
  const out: BandRound[] = [];
  for (const cadence of ['1m', '5m', '1h'] as const) {
    for (const market of bandCandidates(markets, cadence, now)) {
      if (market.expiry_market_id !== heroId) out.push({ cadence, market });
    }
  }
  return out.sort((a, b) => a.market.expiry - b.market.expiry).slice(0, max);
}
