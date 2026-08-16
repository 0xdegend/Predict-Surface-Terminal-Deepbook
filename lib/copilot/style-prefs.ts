/**
 * lib/copilot/style-prefs.ts — turn Kelly's remembered notes about a trader into a
 * soft bias she can apply when she recommends a bet.
 *
 * Auto-remember (lib/copilot/auto-memory) writes a trader's revealed style in a known
 * shape ("leans UP and prefers safer bets", "leans DOWN and likes bolder, higher-payout
 * bets", "likes range bets on BTC"), so we can read it back with plain keyword matching.
 * The manual "remember …" path is free text, so we match the same keywords loosely.
 *
 * The bias is SOFT: it only breaks ties / fills in a default when the trader hasn't said
 * what they want ("recommend a bet"). An explicit ask ("safe up bet") always wins — the
 * host only passes preference into the open-ended recommend path. Pure + testable.
 */

export type StyleLean = 'up' | 'down';
export type StyleRisk = 'safe' | 'bold';

export interface StylePrefs {
  /** The trader's usual direction, when the notes reveal one. */
  lean?: StyleLean;
  /** Whether they usually go safer or bolder. */
  risk?: StyleRisk;
  /** They've traded ranges before. */
  likesRange?: boolean;
}

/**
 * Read a soft style bias out of Kelly's recalled memory notes (most-relevant first).
 * The FIRST note that reveals a given trait wins, so a conflicting older note can't
 * override a fresher, more relevant one.
 */
export function parseStylePrefs(memories: string[]): StylePrefs {
  const prefs: StylePrefs = {};
  for (const raw of memories) {
    const t = raw.toLowerCase();
    if (prefs.lean === undefined) {
      // Match the auto-remember phrasing ("leans up") and plain "up bets".
      if (/\b(leans?\s+up|up\s+bets?|bull(ish)?|going up)\b/.test(t)) prefs.lean = 'up';
      else if (/\b(leans?\s+down|down\s+bets?|bear(ish)?|going down)\b/.test(t)) prefs.lean = 'down';
    }
    if (prefs.risk === undefined) {
      if (/\b(safer|safe\s+bets?|cautious|conservative|low\s*risk)\b/.test(t)) prefs.risk = 'safe';
      else if (/\b(bolder|bold|longshot|higher[-\s]?payout|risky|aggressive|degen)\b/.test(t)) prefs.risk = 'bold';
    }
    if (prefs.likesRange === undefined && /\brange\b/.test(t)) prefs.likesRange = true;
  }
  return prefs;
}

/** True when there's any bias worth applying. */
export function hasStylePrefs(p: StylePrefs): boolean {
  return p.lean !== undefined || p.risk !== undefined || !!p.likesRange;
}

/**
 * A short, natural lead-in Kelly prepends to a personalized recommendation, e.g.
 * "Since you usually lean UP and keep it safer, ". Returns null when there's nothing
 * worth saying, so callers only personalize when they actually can.
 */
export function preferenceLine(p: StylePrefs): string | null {
  const bits: string[] = [];
  if (p.lean) bits.push(`lean ${p.lean.toUpperCase()}`);
  if (p.risk) bits.push(p.risk === 'safe' ? 'keep it safer' : 'go for bigger payouts');
  if (bits.length === 0) return null;
  const joined = bits.length === 1 ? bits[0] : `${bits[0]} and ${bits[1]}`;
  return `Since you usually ${joined}, here's one in that style.`;
}
