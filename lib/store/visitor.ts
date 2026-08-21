'use client';

/**
 * lib/store/visitor — has this browser used Skew before?
 *
 * The first-visit dialog asks "New to prediction markets?". Put that in front of someone
 * who has been trading here for weeks and the app looks like it has forgotten them. So
 * the two audiences get different things: a newcomer gets the question, a returning
 * trader gets a quiet note that simple mode exists.
 *
 * HOW WE TELL. There is no account to check on a cold landing — no wallet yet, no
 * history. What there IS, for anyone who has used the app, is a browser full of our own
 * state: tour flags, deployment choice, session prefs, the Kelly dock hint, the surface
 * coach. Any one of those means a previous session happened.
 *
 * TWO TRAPS THIS AVOIDS.
 *
 * 1. Self-detection. `skew.tradeView` is written BY the dialog's own store, so counting
 *    it would make every visitor look like a returning one the moment they answered.
 *    It's excluded, along with this module's own key.
 *
 * 2. Racing ourselves. Several of those flags get written seconds into a first visit
 *    (the surface coach, the Kelly dock), so a genuine newcomer would classify as
 *    "returning" on their second page view of the SAME session. So the verdict is
 *    computed ONCE, the first time it's ever asked, and then written down. After that
 *    it's a lookup, not a guess, and it can't drift.
 *
 * A returning trader on a new device reads as new. That's unavoidable without an account,
 * and it costs them one click on "I trade already".
 */

export type Visitor = 'new' | 'returning';

export const VISITOR_KEY = 'skew.visitor.v1';

/** Keys written by this feature itself — counting them would be circular. */
const OWN_KEYS = new Set([VISITOR_KEY, 'skew.tradeView']);

/** Everything the app persists is prefixed one of these ways. */
const APP_KEY = /^(skew|predict\.|kelly-)/i;

/** The verdict for a given set of storage keys. Pure, so the rule is testable. */
export function classifyVisitor(keys: readonly string[]): Visitor {
  return keys.some((k) => !OWN_KEYS.has(k) && APP_KEY.test(k)) ? 'returning' : 'new';
}

/**
 * The verdict for this browser, decided once and remembered. Returns 'new' when storage
 * is unavailable (private mode, storage blocked): a newcomer shown the question loses
 * nothing, while a returning trader wrongly shown a "try simple mode" note would just be
 * confusing.
 */
export function visitorKind(): Visitor {
  if (typeof window === 'undefined') return 'new';
  try {
    const stored = window.localStorage.getItem(VISITOR_KEY);
    if (stored === 'new' || stored === 'returning') return stored;
    const verdict = classifyVisitor(Object.keys(window.localStorage));
    window.localStorage.setItem(VISITOR_KEY, verdict);
    return verdict;
  } catch {
    return 'new';
  }
}
