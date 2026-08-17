/**
 * lib/copilot/lessons.ts — Kelly's learning loop: what the trader is actually GOOD at.
 *
 * The auto-memory writer records a trader's STYLE at the moment they place a bet
 * (lib/copilot/auto-memory.ts). This module is the other half: it looks at how their
 * bets actually SETTLED and derives durable lessons — the buckets where they beat the
 * odds and the ones where they don't. Those lessons (a) get written to Kelly's Walrus
 * memory so she can mention them and ground the LLM, and (b) softly bias the open-ended
 * "best bet" recommendation toward the lane the trader wins in.
 *
 * "Beating the odds" is measured as EDGE = actual win rate − the average implied (fair)
 * probability the trader paid. A favorite winning often isn't a lesson; a favorite
 * winning MORE than its price implied is. Pure and side-effect free, so it's unit-tested.
 */
import type { PastPrediction } from '@/lib/portfolio/history';

export type LearnedLean = 'up' | 'down';
export type LearnedRisk = 'safe' | 'bold';

/** A soft, outcome-derived profile of the trader's edge. Every field is optional: we
 *  only set one when the settled history clears the sample + edge-gap bars below. */
export interface LearnedProfile {
  /** The direction their binary bets have done better on. */
  lean?: LearnedLean;
  /** Whether their safer (favorite) or bolder (longshot) bets have beaten fair. */
  risk?: LearnedRisk;
  /** True when their range bets have beaten fair by more than their binaries. */
  likesRange?: boolean;
  /** How many settled bets the profile was derived from. */
  sample: number;
}

// Guards against learning from noise. Need a real history first, a minimum per bucket,
// and one side must beat the other's edge by a clear margin before we call it.
const MIN_TOTAL = 6;
const MIN_BUCKET = 3;
const EDGE_DELTA = 0.1;
// Conviction proxy from the implied entry price (0..1): a high implied is a favorite
// (safer), a low implied is a longshot (bolder); the middle is ambiguous and excluded.
const SAFE_MIN = 0.55;
const BOLD_MAX = 0.4;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

interface Bucket {
  edge: number; // win rate − average implied
  n: number;
}

/** Edge for a set of settled rows, or null when there aren't enough to trust. */
function bucketEdge(rows: PastPrediction[]): Bucket | null {
  if (rows.length < MIN_BUCKET) return null;
  const winRate = rows.filter((r) => r.result === 'won').length / rows.length;
  const avgImplied = rows.reduce((s, r) => s + clamp01(r.entryPrice), 0) / rows.length;
  return { edge: winRate - avgImplied, n: rows.length };
}

/** Which of two buckets clearly wins on edge, or null if neither clears the gap. */
function betterOf<T extends string>(
  a: { key: T; bucket: Bucket | null },
  b: { key: T; bucket: Bucket | null },
): T | undefined {
  if (!a.bucket || !b.bucket) return undefined;
  if (a.bucket.edge - b.bucket.edge >= EDGE_DELTA) return a.key;
  if (b.bucket.edge - a.bucket.edge >= EDGE_DELTA) return b.key;
  return undefined;
}

/**
 * Derive the trader's learned profile from their settled bets. Returns an empty profile
 * (just `sample`) until there's enough history, and only sets a field when one bucket
 * clearly out-edges the other.
 */
export function deriveLearnedProfile(history: PastPrediction[]): LearnedProfile {
  const settled = history.filter((h) => h.result === 'won' || h.result === 'lost');
  const profile: LearnedProfile = { sample: settled.length };
  if (settled.length < MIN_TOTAL) return profile;

  const binary = settled.filter((h) => !h.band);
  const range = settled.filter((h) => h.band);

  // Direction (binary only — a range has no up/down).
  const lean = betterOf(
    { key: 'up' as LearnedLean, bucket: bucketEdge(binary.filter((h) => h.up)) },
    { key: 'down' as LearnedLean, bucket: bucketEdge(binary.filter((h) => !h.up)) },
  );
  if (lean) profile.lean = lean;

  // Risk (favorite vs longshot, by implied entry price).
  const risk = betterOf(
    { key: 'safe' as LearnedRisk, bucket: bucketEdge(settled.filter((h) => clamp01(h.entryPrice) >= SAFE_MIN)) },
    { key: 'bold' as LearnedRisk, bucket: bucketEdge(settled.filter((h) => clamp01(h.entryPrice) <= BOLD_MAX)) },
  );
  if (risk) profile.risk = risk;

  // Range vs binary — only a positive signal (they're notably good at ranges).
  const rangeB = bucketEdge(range);
  const binaryB = bucketEdge(binary);
  if (rangeB && binaryB && rangeB.edge - binaryB.edge >= EDGE_DELTA) profile.likesRange = true;

  return profile;
}

/**
 * Stable, number-free memory notes for the trader's strongest lessons — written to
 * Kelly's Walrus memory. Kept free of volatile counts so re-writing across sessions
 * stays near-idempotent (MemWal has no update/delete). Capped at two so memory stays
 * lean. Priority: risk, then direction, then range.
 */
export function learnedLessonNotes(profile: LearnedProfile): string[] {
  const notes: string[] = [];
  if (profile.risk === 'safe') notes.push('your safer bets have beaten the odds more than your longshots');
  else if (profile.risk === 'bold') notes.push('your bolder longshot bets have paid off');
  if (profile.lean === 'up') notes.push('your results have been better on UP bets');
  else if (profile.lean === 'down') notes.push('your results have been better on DOWN bets');
  if (profile.likesRange) notes.push('your range bets have tended to work out');
  return notes.slice(0, 2);
}

/**
 * A one-line opener for the "best bet" recommendation when the pick reflects what the
 * trader wins at — honest that it comes from their own results, not something they told
 * Kelly. Null when nothing directional/risk-related was learned (so the caller keeps its
 * neutral opener). Range isn't mentioned here since that reply recommends a binary.
 */
export function learnedOpener(profile: LearnedProfile): string | null {
  const parts: string[] = [];
  if (profile.lean) parts.push(`you tend to do better on ${profile.lean.toUpperCase()} bets`);
  if (profile.risk === 'safe') parts.push('safer bets have worked out for you');
  else if (profile.risk === 'bold') parts.push('your bolder bets have paid off');
  if (parts.length === 0) return null;
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Going by your own settled bets, ${joined}, so here's one in that lane.`;
}

// Once-per-session-per-wallet guard for the durable lesson write, mirroring
// auto-memory's claimAutoRememberSlot. Module-level, cleared on reload.
const _lessonClaimed = new Set<string>();

/** True the first time this wallet asks to write lessons this session; false after. */
export function claimLessonSlot(owner: string): boolean {
  const k = owner.toLowerCase();
  if (_lessonClaimed.has(k)) return false;
  _lessonClaimed.add(k);
  return true;
}

/** Test-only: clear the session claim set. */
export function _resetLessonClaims(): void {
  _lessonClaimed.clear();
}
