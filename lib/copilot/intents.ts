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
/** A single market metric the trader can ask about directly — answered with a
 *  focused one/two-liner instead of the full market read. */
export type MetricKind = 'fear_greed' | 'funding' | 'liquidations' | 'max_pain' | 'price' | 'change_24h' | 'open_interest';

/** A price level to quote odds at: an absolute strike, or a % move from spot. */
export type OddsLevel = { kind: 'strike'; price: number } | { kind: 'move'; pct: number };
/** An explicit target on a directional bet: a win-chance (70%) or a payout (3×). */
export type BetTarget = { kind: 'prob'; value: number } | { kind: 'payout'; mult: number };

export type CopilotIntent =
  | { kind: 'analyze' }
  | { kind: 'analyze_strike' }
  | { kind: 'next_market' }
  | { kind: 'start_trade' }
  | { kind: 'metric'; metric: MetricKind }
  | { kind: 'recommend' }
  | { kind: 'balance' }
  | { kind: 'portfolio' }
  | { kind: 'odds'; level: OddsLevel; dir?: BetDirection }
  | { kind: 'reality_check'; level?: OddsLevel; dir?: BetDirection }
  | { kind: 'volatility' }
  | { kind: 'skew' }
  | { kind: 'term_structure'; dir?: BetDirection }
  | { kind: 'no_arb' }
  | { kind: 'busiest_strike'; scope: 'now' | 'all' }
  | { kind: 'directional_bet'; dir: BetDirection; conviction: Conviction; horizon: Horizon; target?: BetTarget }
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
const NEXT_QUALIFIERS = ['next', 'soonest', 'current', 'upcoming', 'coming', 'nearest', 'which', 'live', 'open', 'available'];
// "Set up a trade / walk me through it" — start the guided step-by-step wizard.
// Matched on the RAW text before the "set up"→UP stripping below.
const START_TRADE_PHRASES = ['set up a trade', 'set up trade', 'setup a trade', 'set up my trade', 'set up a bet', 'set up a position', 'build a trade', 'build a bet', 'create a trade', 'make a trade', 'place a trade', 'walk me through', 'guide me', 'step by step', 'help me set up', 'help me place', 'guided trade'];
// Explicit trade PARAMETERS — "strike 66000", "leverage 2", "2x", "6 dusdc". A
// message carrying any of these is building a SPECIFIC trade, so it routes to the
// guided wizard (which fills what's given and asks for the rest) even when phrased
// without a "set up a trade" cue — e.g. "trade 66000 strike, 2x, 6 dusdc".
const TRADE_PARAM = /\bstrike\s*(?:of|is|at|=|:)?\s*\$?\d|\bleverage\s*(?:of|is|at|=|:)?\s*\d|\b\d+(?:\.\d+)?\s*x\b|\b\d[\d,]*\s*dusdc\b/;

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
 *  read a side, so "what's coming up" or "set up a bet" don't become an UP bet.
 *  Exported so the trade wizard's slot parser applies the SAME guard. */
export const NON_DIRECTIONAL = /\b(coming up|up next|what'?s up|whats up|set up|give up|line up|heads up|back up|sign up)\b/g;

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

/** A direct question about ONE metric → answer just that, focused, instead of the
 *  whole market read. Note: bare "sentiment" stays an analyze cue (it's in
 *  ANALYZE_WORDS); only the named "fear & greed" index routes here. */
function metricFrom(text: string): MetricKind | null {
  if (/\bfear\b|\bgreed\b|\bf ?& ?g\b|fear\s*(?:and|&|\/)\s*greed|sentiment index/.test(text)) return 'fear_greed';
  if (/\bfunding\b/.test(text)) return 'funding';
  if (/\bmax ?pain\b|\bpain (?:price|point|level|zone)\b/.test(text)) return 'max_pain';
  if (/\bliquidat|\bliqs?\b/.test(text)) return 'liquidations';
  if (/\bopen interest\b|\boi\b/.test(text)) return 'open_interest';
  // 24h change — needs "how much…up/down", "change/move…today", or a "24h" cue.
  // NOT a bare "up/down…today" (that'd swallow "up bet today").
  if (/\b24 ?h\b|\b24[- ]hour|last 24|daily (?:change|move)|how much (?:is |has |did |'?s )?(?:btc |bitcoin |it )?(?:up|down|gain|gained|lost|moved?|changed)|(?:change|moved?|gain|loss)[^?]{0,15}\btoday\b|today'?s (?:change|move|gain)/.test(text)) return 'change_24h';
  if (/\bspot\b|how much is btc|what'?s btc (?:at|worth|now)|\bbtc price\b|price of btc|current price|price right now/.test(text)) return 'price';
  return null;
}

/** "Should I go up or down (or range)? / which way / what's your call?" — asks for
 *  a steer, not just a read. A clear SINGLE direction is handled before this (it's
 *  already a bet); this catches the undecided "up or down"-style questions. */
function wantsRecommendation(text: string): boolean {
  return /\bshould i\b|\brecommend|which way|\bup or down\b|\bdown or up\b|what should i|your (?:call|pick|take)|which is better|what do you think i should|pick for me|or range\b/.test(text);
}

/** "What's my (wallet) balance? / how much DUSDC do I have?" — show their funds. */
function wantsBalance(text: string): boolean {
  // "my money" is intentionally NOT here — it collides with "double my money"
  // (a payout target). "how much money do I have" still routes to balance.
  return /\bbalance\b|how much (?:dusdc|money|funds|do i have)|\bmy (?:wallet|funds|dusdc)\b|how much.*\bwallet\b/.test(text);
}

/** "How is my portfolio / how are my bets doing / am I up?" — a performance +
 *  balances roll-up (broader than the funds-only `balance`). Checked before the
 *  directional branch so "am I up" isn't read as an UP bet. */
function wantsPortfolio(text: string): boolean {
  return (
    /\bportfolio\b|\bmy (?:positions?|bets?|trades?|holdings?|pnl|p&l|profit|performance|book|gains?|losses?)\b|how (?:am i|'?m i|are (?:my|things)|is my (?:portfolio|book|account|trading))|am i (?:up|down|winning|losing|in profit|making money|losing money)|how('?s| is| are) (?:my|the) (?:portfolio|bets?|trades?|positions?)|how are (?:my )?(?:bets?|trades?|positions?) (?:doing|performing|going)/.test(
      text,
    )
  );
}

/** "Analyse this / the current live strike" — a focused read of the strike the
 *  ticket is currently on (surface odds + reality check + market context), not the
 *  whole-market `analyze`. Needs a strike/this-bet cue AND an analysis cue. */
function wantsStrikeAnalysis(text: string): boolean {
  if (!/\bstrike\b|\bthis (?:bet|trade|level|price|position|market)\b|\bcurrent (?:bet|trade|level|price)\b/.test(text)) return false;
  return /analy|\bread\b|break ?down|explain|assess|evaluate|thoughts?|\bhow('?s| is)\b|good (?:bet|strike|call|idea)|worth (?:it|trading|a bet)|is this|\blook(?:s|ing)?\b|\bcheck\b|\brate\b/.test(text);
}

/**
 * A short "place the bet now" confirmation ("trade it", "place it", "yes", "do it")
 * — the typed equivalent of tapping the review card's Trade it / Place this bet
 * button. The screen only acts on it when a bet is actually pending, so a lone
 * "yes" with nothing set up just falls through. A parameter-packed message (a NEW
 * trade spec) or a long sentence is never a confirmation.
 */
export function isPlaceConfirmation(message: string): boolean {
  const t = message.toLowerCase().trim().replace(/[’]/g, "'").replace(/[.!]+$/, '');
  if (!t || TRADE_PARAM.test(t)) return false;
  if (t.split(/\s+/).length > 6) return false; // confirmations are short
  // "<verb> it/this/that/(the|my) bet/trade/position" — the object keeps a bare
  // "trade 66000" (a new spec) from matching.
  if (/\b(?:trade|place|open|send|do|lock)\s+(?:it|this|that|(?:the |my )?(?:bet|trade|position|order))\b/.test(t)) return true;
  // Standalone affirmations.
  return /^(?:yes|yep|yeah|yup|ok|okay|sure|confirm|do it|go|go for it|let'?s go|lets go|send it|lock it in|place it|trade it|open it)$/.test(t);
}

/** "What are the odds BTC is above $67k / of a 1% move up?" — a question about the
 *  chance at a specific level or move. Needs an odds cue AND a number. */
/** Pull a price level from text: a % MOVE ("1% move up") or an absolute strike
 *  ("$67k" / "67,000"). A % needs MOVE wording so "70% chance" (a probability) is
 *  not read as a 70% price move. (% has no trailing \b — it's not a word char.) */
function levelFrom(text: string): OddsLevel | null {
  const MOVE_WORDS = 'move|moves|movement|swing|jump|drop|rise|risen|gain|fall|falls|pop|higher|lower';
  const move =
    text.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:%|percent|pct)\\s*(?:${MOVE_WORDS})`)) ??
    text.match(new RegExp(`(?:${MOVE_WORDS})\\D{0,12}(\\d+(?:\\.\\d+)?)\\s*(?:%|percent|pct)`));
  if (move) return { kind: 'move', pct: parseFloat(move[1]) };
  const k = text.match(/\$?(\d+(?:\.\d+)?)\s*k\b/);
  if (k) return { kind: 'strike', price: parseFloat(k[1]) * 1000 };
  const big = text.match(/\$?(\d[\d,]{3,}(?:\.\d+)?)/);
  if (big) {
    const price = parseFloat(big[1].replace(/,/g, ''));
    if (price >= 1000) return { kind: 'strike', price };
  }
  return null;
}

function dirFrom(text: string): BetDirection | undefined {
  const up = has(text, UP_WORDS);
  const down = has(text, DOWN_WORDS);
  return up !== down ? (up ? 'up' : 'down') : undefined;
}

function oddsFrom(text: string): { level: OddsLevel; dir?: BetDirection } | null {
  if (!/\bodds\b|\bchances?\b|\blikely\b|likelihood|\bprobabilit/.test(text)) return null;
  const level = levelFrom(text);
  return level ? { level, dir: dirFrom(text) } : null;
}

/** "How often does a 1% move actually happen? / has BTC really moved that much
 *  lately?" — a base-rate (reality) check against the price history. */
function wantsRealityCheck(text: string): boolean {
  return /how often|historically|\bin the past\b|base ?rate|hit ?rate|track record|actually (?:move|moved|happen|happens|happened|go|gone|land)|really (?:move|moved|happen)|(?:happen|move|moved|landed).{0,15}\blately\b|how many times|how frequently|realistic(?:ally)?|\bin reality\b|empiric/.test(text);
}

/* ---- surface-native analysis questions (vol / skew / term / no-arb) ---- */

/** "How big a move is priced in? / is vol high?" — the surface's Z-axis. */
function wantsVolatility(text: string): boolean {
  return /\bvolatility\b|\bhow volatile\b|how big (?:a |of a )?move|(?:big|large|expected|likely) move|move (?:that'?s |is )?priced in|priced[- ]in move|expected (?:range|move|swing)|how much (?:could|will|might|can) (?:btc|it|price) (?:move|swing)/.test(text);
}

/** "Crash or pump? / which tail is bigger?" — the surface's skew/shape. */
function wantsSkew(text: string): boolean {
  return /\bskew\b|crash or pump|pump or crash|bracing for|(?:bigger|more) (?:on the )?(?:downside|upside)|downside.{0,10}upside|upside.{0,10}downside|tail risk|priced for a (?:crash|drop|pump|rally)|fear(?:ing)? a (?:crash|drop)/.test(text);
}

/** "Any mispricings? / is the surface arb-free?" — the no-arb checker. */
function wantsNoArb(text: string): boolean {
  return /arbitrage|no[- ]?arb|arb[- ]?free|mispric|is the surface (?:ok|healthy|clean|arb|fair|right)|surface (?:healthy|clean|broken|glitch)/.test(text);
}

/** "Which strike has the most volume? / busiest strike? / where's the action?" —
 *  needs a volume/activity cue AND a strike/level (or surface) cue, so it doesn't
 *  fire on "biggest move" (that's volatility) or a bare "volume". */
function wantsBusiestStrike(text: string): boolean {
  const volumeCue = /\bbusiest\b|\bhottest\b|most (?:traded|active|popular|bet on|volume|action|bets)|\bmost volume\b|where.{0,20}(?:action|money|volume|bets|flow)|\bmost bets?\b/.test(text);
  const strikeCue = /\bstrikes?\b|\bprice level\b|which (?:strike|level|price)|on the surface|\bfrom the surface\b/.test(text);
  return volumeCue && strikeCue;
}

/** "Right now / currently / live" → the single live market; otherwise every open
 *  expiry. (The user's rule: a "now"-style cue scopes to the current market.) */
function busiestScope(text: string): 'now' | 'all' {
  return /\bnow\b|right now|currently|at the moment|\blive\b|at present/.test(text) ? 'now' : 'all';
}

/** "1-minute or 5-minute? / which expiry? / wait for the hour?" — the Y-axis. */
function wantsTermStructure(text: string): boolean {
  if (/\bterm structure\b|\bexpir(?:y|ies|es)\b/.test(text)) return true;
  if (/which (?:market|timeframe|time ?frame|one|tenor).{0,20}(?:better|best|odds|good|safer)/.test(text)) return true;
  if (/(?:shorter|longer)[- ]?(?:dated|expiry|market|term|one|tenor)|wait for the (?:\d+|one|an? )?[- ]?(?:hour|min)/.test(text)) return true;
  // Two horizons compared: "1 min or 5 min", "1m vs 5m", "1-minute or 1-hour".
  if (/\b\d+\s*-?\s*(?:m|min|minute|h|hour)s?\b[^?]{0,20}\b(?:or|vs|versus)\b[^?]{0,20}\b\d+\s*-?\s*(?:m|min|minute|h|hour)s?\b/.test(text)) return true;
  return false;
}

/** An explicit target on a directional bet: "70% chance" → prob; "double/triple
 *  my money" → payout. NOTE bare "3x" reads as LEVERAGE (TRADE_PARAM → the
 *  wizard), so an unambiguous payout uses double/triple wording. */
function targetFrom(text: string): BetTarget | null {
  const prob = text.match(/(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|pct)(?:\s*(?:chance|odds|likely|shot))?/);
  if (prob) {
    const v = parseFloat(prob[1]) / 100;
    if (v > 0 && v < 1) return { kind: 'prob', value: v };
  }
  if (/\bdouble (?:my |the )?(?:money|stake|it|up)\b/.test(text)) return { kind: 'payout', mult: 2 };
  if (/\btriple (?:my |the )?(?:money|stake|it)\b/.test(text)) return { kind: 'payout', mult: 3 };
  return null;
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
  // Explicit trade params (strike/leverage/amount) also route here, so a
  // parameter-packed message is understood as building a trade however it's worded.
  if (has(raw, START_TRADE_PHRASES) || TRADE_PARAM.test(raw)) return { kind: 'start_trade' };

  const text = raw.replace(NON_DIRECTIONAL, ' ');

  const up = has(text, UP_WORDS);
  const down = has(text, DOWN_WORDS);
  const wantsAnalysis = has(text, ANALYZE_WORDS);
  const wantsBet = has(text, BET_WORDS);

  // "What are the odds at $X / of a Y% move?" — a chance question. Checked before
  // the directional branch because "odds BTC ABOVE $67k" carries a side word.
  const odds = oddsFrom(text);
  if (odds) return { kind: 'odds', ...odds };

  // "Which strike has the most volume?" — a distinct volume-by-strike ask. Before
  // the other surface questions so "most volume" isn't misread as "biggest move".
  if (wantsBusiestStrike(text)) return { kind: 'busiest_strike', scope: busiestScope(text) };

  // Surface-native analysis (vol / skew / term / no-arb / reality check). Before
  // the directional branch too — "crash or pump" carries both sides, "1m or 5m for
  // up" and "how often does a 1% move up happen" carry one.
  if (wantsNoArb(text)) return { kind: 'no_arb' };
  if (wantsSkew(text)) return { kind: 'skew' };
  if (wantsVolatility(text)) return { kind: 'volatility' };
  if (wantsTermStructure(text)) return { kind: 'term_structure', dir: dirFrom(text) };
  if (wantsRealityCheck(text)) return { kind: 'reality_check', level: levelFrom(text) ?? undefined, dir: dirFrom(text) };
  // "Analyse the current/this strike" — a focused read of the selected strike,
  // before the plain analyze cue (which "analyse" would otherwise trigger).
  if (wantsStrikeAnalysis(text)) return { kind: 'analyze_strike' };

  // Focused data questions — how the trader's own book is doing, a single metric
  // ("fear & greed", "how much is BTC up today"), or the balance. BEFORE the
  // directional branch, since "am I up" / "up today" carry a direction word that
  // isn't a bet. Portfolio (performance + funds) beats the funds-only balance.
  if (wantsPortfolio(text)) return { kind: 'portfolio' };
  const metric = metricFrom(text);
  if (metric) return { kind: 'metric', metric };
  if (wantsBalance(text)) return { kind: 'balance' };

  // Exactly one direction → a directional bet (a bet verb isn't required:
  // "give me a safe up" or "I think BTC goes up" both clearly want a side). An
  // explicit "70% chance" / "double my money" target overrides the conviction wording.
  if (up !== down) {
    return { kind: 'directional_bet', dir: up ? 'up' : 'down', conviction: convictionFrom(text), horizon: horizonFrom(text), target: targetFrom(text) ?? undefined };
  }

  // Naming BOTH sides ("up trade or down trade?", "up or down?") or explicitly
  // asking for a steer ("which way?", "what's your call?") → a soft
  // recommendation. Checked before analyze so an either/or question gets an
  // actual steer (which still carries the read) instead of the bare description.
  if ((up && down) || wantsRecommendation(text)) return { kind: 'recommend' };

  // "Which/what's the next market" → the soonest-market answer. Checked before
  // analyze because "what IS the next market" also trips the analyze cue.
  if (wantsNextMarket(text)) return { kind: 'next_market' };

  // An analysis cue with no direction → the plain read.
  if (wantsAnalysis) return { kind: 'analyze' };

  // A bet verb with no clear side → help (we don't guess the direction).
  if (wantsBet) return { kind: 'help' };

  return { kind: 'help' };
}
