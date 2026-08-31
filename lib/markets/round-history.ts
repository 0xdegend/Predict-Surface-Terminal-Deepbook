/**
 * lib/markets/round-history — how a finished round CLOSED: above its line, or below.
 *
 * Simple mode's results tape is a row of up/down marks for the last handful of rounds
 * on the chosen cadence. That reads as trivia, but it is the one place the screen makes
 * a factual claim about the past, so it has to be resolved the same way the protocol
 * resolved the bet — against the round's OWN line, not against spot, and not against
 * the line of the round currently on screen.
 *
 * A round is only counted once BOTH halves are in: the line it was judged against
 * (`reference_tick`, a tick index, priced via `tickToStrike` exactly as the live ticket
 * prices it) and the settlement price the chain wrote. An expired-but-unsettled round
 * returns null and is simply left out, rather than being guessed at from spot.
 *
 * Pure and side-effect free (no React, no network) so it unit-tests without a chain;
 * [[lib/markets/round-history.live.test]] proves the inputs actually exist on expired
 * markets. See [[simple-mode]].
 */
import { toFloat } from '@/config/scale';
import { roundLineScaled } from '@/lib/sui/v2/simple-round';
import { cadenceOf } from '@/lib/markets/v2-discovery';
import type { SimpleCadence } from '@/lib/markets/round-pick';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';

export interface RoundOutcome {
  marketId: string;
  /** When the round closed (ms epoch) — the tape reads oldest to newest by this. */
  expiry: number;
  /** The line the round was judged against (float $). */
  line: number;
  /** The chain's settlement price (float $). */
  settlement: number;
  /** True when it settled at or above the line, i.e. an UP bet won. */
  up: boolean;
}

/**
 * A finished round's outcome, or null while it can't be stated as fact.
 *
 * Null covers three genuinely different cases on purpose — no state read yet, no
 * settlement written yet, no line pinned — because the caller's response to all three
 * is the same: leave the round out until it can be resolved honestly.
 */
export function settledOutcome(market: V2Market, state: V2MarketState | null | undefined): RoundOutcome | null {
  const settledPx = state?.settlement?.settlement_price;
  if (settledPx == null || settledPx === '') return null;
  // The ATM fallback in `roundLineScaled` needs a live forward, which a finished round
  // no longer has. A round with no pinned line therefore can't be resolved after the
  // fact, so require the pin rather than passing a made-up forward.
  const { lineScaled, pinned } = roundLineScaled(state?.reference_tick, 0, market.tick_size, market.admission_tick_size);
  if (!pinned) return null;

  const line = toFloat(lineScaled);
  const settlement = toFloat(BigInt(settledPx));
  if (!Number.isFinite(line) || !Number.isFinite(settlement) || line <= 0) return null;

  return { marketId: market.expiry_market_id, expiry: market.expiry, line, settlement, up: settlement >= line };
}

/** How many of these rounds closed UP — the tape's one-line summary. */
export function upCount(outcomes: RoundOutcome[]): number {
  return outcomes.filter((o) => o.up).length;
}

/** Below this many finished rounds a cadence has no story to tell, so fall back. */
export const MIN_FOR_TAPE = 3;
/** The fallback: the fastest cadence, and so always the one with the most history. */
export const FALLBACK_CADENCE: SimpleCadence = '1m';

/**
 * WHICH finished rounds the tape should resolve, and which cadence they came from.
 *
 * Decided from market rows alone — no state reads — so the caller's fan-out is a
 * stable, bounded list rather than something that grows as answers arrive.
 *
 * The fallback exists because the cadences are not equally observable. The markets list
 * is a capped walk of `MarketCreated` events, which at the live pace holds dozens of
 * finished 1-minute rounds, a handful of 5-minute, and no hourly at all (the protocol
 * keeps only one hourly market alive at a time). The hourly tab therefore has no history
 * of its own and never will. Returning `from` alongside the rounds is what lets the tape
 * say which cadence it is showing instead of implying the marks belong to the round on
 * screen.
 */
export function pickHistoryRounds(
  markets: V2Market[],
  cadence: SimpleCadence,
  now: number,
  count: number,
): { picked: V2Market[]; from: SimpleCadence } {
  const finished = markets.filter((m) => m.expiry <= now).sort((a, b) => b.expiry - a.expiry);
  const of = (c: SimpleCadence) => finished.filter((m) => cadenceOf(m) === c).slice(0, count);

  const own = of(cadence);
  if (own.length >= MIN_FOR_TAPE) return { picked: own, from: cadence };
  if (cadence === FALLBACK_CADENCE) return { picked: own, from: cadence };

  const fallback = of(FALLBACK_CADENCE);
  // Only fall back to something worth showing; otherwise keep the honest empty.
  return fallback.length >= MIN_FOR_TAPE ? { picked: fallback, from: FALLBACK_CADENCE } : { picked: own, from: cadence };
}
