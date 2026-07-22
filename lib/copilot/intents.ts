/**
 * lib/copilot/intents.ts — the Predict co-pilot's rule-based intent parser.
 *
 * Turns a plain-English message into a structured, typed intent the responder
 * can act on. This is the deterministic stand-in for a future LLM router: the
 * seam is the `CopilotIntent` union — today `parseIntent()` fills it by rule;
 * later an Anthropic tool-caller can emit the SAME shape and nothing downstream
 * changes (mirrors the market-read `source: 'rules' | 'ai'` seam).
 *
 * Pure and side-effect free (no fetch, no React) so it's unit-tested. Deliberately
 * forgiving: unknown → a friendly help intent rather than an error, and the
 * suggested-prompt chips in the UI map 1:1 onto these intents so the common paths
 * are always one tap away even when free text is messy.
 */

export type Conviction = 'safe' | 'even' | 'longshot';
export type Horizon = 'soonest' | 'hour';
export type BetDirection = 'up' | 'down';

export type CopilotIntent =
  | { kind: 'analyze' }
  | { kind: 'next_market' }
  | { kind: 'start_trade' }
  | { kind: 'directional_bet'; dir: BetDirection; conviction: Conviction; horizon: Horizon }
  | { kind: 'help' };

/** Word lists — matched as whole words so "moon" hits but "afternoon" doesn't. */
const UP_WORDS = ['up', 'higher', 'above', 'over', 'rise', 'rising', 'rally', 'moon', 'bull', 'bullish', 'pump', 'long', 'green', 'climb', 'gain'];
const DOWN_WORDS = ['down', 'lower', 'below', 'under', 'fall', 'falling', 'drop', 'dump', 'bear', 'bearish', 'short', 'red', 'crash', 'sink', 'dip'];
const SAFE_WORDS = ['safe', 'safer', 'safest', 'likely', 'confident', 'sure', 'conservative', 'low risk', 'low-risk', 'secure'];
const LONGSHOT_WORDS = ['longshot', 'long shot', 'long-shot', 'moonshot', 'risky', 'unlikely', 'yolo', 'gamble', 'lottery', 'big payout', 'high payout', 'big win'];
const ANALYZE_WORDS = ['analyse', 'analyze', 'analysis', 'movement', 'moving', 'move', 'outlook', 'read', 'context', 'happening', 'trend', 'sentiment', 'overview', 'how is', "how's", "what's", 'what is', 'whats', 'look like', 'doing'];
const BET_WORDS = ['bet', 'trade', 'buy', 'play', 'position', 'stake', 'wager', 'go '];
// "What / when is the next market" — asks WHICH market, not for a read of it.
const NEXT_MARKET_PHRASES = ['next market', 'soonest market', 'current market', 'which market', 'nearest market', 'upcoming market', 'next round', 'next one', 'what market'];
const NEXT_QUALIFIERS = ['next', 'soonest', 'current', 'upcoming', 'coming', 'nearest', 'which'];
// "Set up a trade / walk me through it" — start the guided step-by-step wizard.
// Matched on the RAW text before the "set up"→UP stripping below.
const START_TRADE_PHRASES = ['set up a trade', 'set up trade', 'setup a trade', 'set up my trade', 'set up a bet', 'set up a position', 'build a trade', 'build a bet', 'create a trade', 'make a trade', 'place a trade', 'walk me through', 'guide me', 'step by step', 'help me set up', 'help me place', 'guided trade'];

/**
 * Whole-word (or phrase) presence test, case-insensitive. Single words also match
 * a trailing "s" so "falls"/"rises"/"drops" hit their base word — but the word
 * boundary still prevents substrings ("under" won't fire on "understand").
 */
function has(haystack: string, needles: string[]): boolean {
  return needles.some((n) => {
    if (n.includes(' ')) return haystack.includes(n);
    return new RegExp(`\\b${n}s?\\b`).test(haystack);
  });
}

/** Phrases where "up"/"down" isn't a market direction — neutralized before we
 *  read a side, so "what's coming up" or "set up a bet" don't become an UP bet. */
const NON_DIRECTIONAL = /\b(coming up|up next|what'?s up|whats up|set up|give up|line up|heads up|back up|sign up)\b/g;

function convictionFrom(text: string): Conviction {
  if (has(text, SAFE_WORDS)) return 'safe';
  if (has(text, LONGSHOT_WORDS)) return 'longshot';
  return 'even';
}

function horizonFrom(text: string): Horizon {
  return /\bhour\b|\b1\s*hr?\b|\b60\s*min/.test(text) ? 'hour' : 'soonest';
}

/** "Which market can I bet on / what's the next one" — an explicit phrase, or
 *  "market"/"round" paired with a next/soonest/current-style qualifier. */
function wantsNextMarket(text: string): boolean {
  if (has(text, NEXT_MARKET_PHRASES)) return true;
  return has(text, ['market', 'round']) && has(text, NEXT_QUALIFIERS);
}

/**
 * Parse a message into an intent. Priority:
 *  1. A single clear direction (up XOR down) → a directional bet.
 *  2. Both/neither direction but an analysis ask → analyze.
 *  3. Anything else → help.
 * Asking "up or down?" (both words) is a question, not a commitment, so it reads
 * as analyze rather than an accidental bet.
 */
export function parseIntent(message: string): CopilotIntent {
  const raw = message.toLowerCase().trim();
  if (!raw) return { kind: 'help' };
  // Start the guided wizard FIRST, on raw text — "set up a trade" must beat the
  // NON_DIRECTIONAL strip (which would otherwise remove "set up") and the "up".
  if (has(raw, START_TRADE_PHRASES)) return { kind: 'start_trade' };

  const text = raw.replace(NON_DIRECTIONAL, ' ');

  const up = has(text, UP_WORDS);
  const down = has(text, DOWN_WORDS);
  const wantsAnalysis = has(text, ANALYZE_WORDS);
  const wantsBet = has(text, BET_WORDS);

  // Exactly one direction → a directional bet (a bet verb isn't required:
  // "give me a safe up" or "I think BTC goes up" both clearly want a side).
  if (up !== down) {
    return { kind: 'directional_bet', dir: up ? 'up' : 'down', conviction: convictionFrom(text), horizon: horizonFrom(text) };
  }

  // "Which/what's the next market" → the soonest-market answer. Checked before
  // analyze because "what IS the next market" also trips the analyze cue.
  if (wantsNextMarket(text)) return { kind: 'next_market' };

  // Both directions ("up or down"), or none, with an analysis cue → analyze.
  if (wantsAnalysis || (up && down)) return { kind: 'analyze' };

  // A bet verb with no clear side → help (we don't guess the direction).
  if (wantsBet) return { kind: 'help' };

  return { kind: 'help' };
}
