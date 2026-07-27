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
export type Horizon = 'soonest' | 'hour' | 'today';
export type BetDirection = 'up' | 'down';
/** A single market metric the trader can ask about directly — answered with a
 *  focused one/two-liner instead of the full market read. */
export type MetricKind = 'fear_greed' | 'funding' | 'liquidations' | 'max_pain' | 'price' | 'change_24h' | 'open_interest';

/** A price level to quote odds at: an absolute strike, or a % move from spot. */
export type OddsLevel = { kind: 'strike'; price: number } | { kind: 'move'; pct: number };
/** An explicit target on a directional bet: a win-chance (70%) or a payout (3×). */
export type BetTarget = { kind: 'prob'; value: number } | { kind: 'payout'; mult: number };
/** A "how does X work?" topic the co-pilot can explain in plain language. */
export type ExplainTopic = 'leverage' | 'range' | 'binary' | 'settlement' | 'loss' | 'fees' | 'funds' | 'payout' | 'predict';

export type CopilotIntent =
  | { kind: 'analyze' }
  | { kind: 'analyze_strike'; price?: number; dir?: BetDirection }
  | { kind: 'next_market' }
  | { kind: 'start_trade' }
  | { kind: 'metric'; metric: MetricKind }
  | { kind: 'recommend' }
  | { kind: 'balance' }
  | { kind: 'portfolio' }
  | { kind: 'track_record'; focus: 'last' | 'win_rate' | 'loss_rate'; ask?: 'win' | 'lose' }
  | { kind: 'odds'; level: OddsLevel; dir?: BetDirection; horizon?: Horizon }
  | { kind: 'reality_check'; level?: OddsLevel; dir?: BetDirection }
  | { kind: 'volatility' }
  | { kind: 'skew' }
  | { kind: 'term_structure'; dir?: BetDirection }
  | { kind: 'no_arb' }
  | { kind: 'busiest_strike'; scope: 'now' | 'all' }
  | { kind: 'surface_volume'; scope: 'now' | 'all' }
  | { kind: 'markets_overview' }
  | { kind: 'biggest_payout' }
  | { kind: 'find_strike'; price: number; dir?: BetDirection }
  | { kind: 'explain'; topic: ExplainTopic }
  | { kind: 'best_value' }
  | { kind: 'positioning' }
  | { kind: 'flow' }
  | { kind: 'options_market' }
  | { kind: 'why_moving' }
  // Onboarding: get-started guidance, create the trading account, get test tokens.
  | { kind: 'onboarding' }
  | { kind: 'create_account' }
  | { kind: 'get_tokens' }
  | { kind: 'adjust_ticket'; stake?: number; leverage?: number; strike?: number; dir?: BetDirection; flip?: boolean }
  | { kind: 'close_position'; all?: boolean; winnings?: boolean; dir?: BetDirection; strike?: number }
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
export const NON_DIRECTIONAL = /\b(coming up|up next|what'?s up|whats up|set up|give up|line up|heads up|back up|sign up|how long|so long)\b/g;

function convictionFrom(text: string): Conviction {
  if (has(text, SAFE_WORDS)) return 'safe';
  if (has(text, LONGSHOT_WORDS)) return 'longshot';
  return 'even';
}

function horizonFrom(text: string): Horizon {
  // Multiple hours / today / rest of the day → price the LONGEST market we list
  // (this venue's markets are short, so that's the best available answer).
  if (/\btoday\b|\btonight\b|this (?:afternoon|evening|morning)|end of (?:the )?day|\beod\b|rest of (?:the )?day|(?:few|couple|several|\d+)\s*(?:more\s*)?hours|\bhours\b/.test(text)) return 'today';
  // About an hour out.
  if (/\bhour\b|\b1\s*hr?\b|\b60\s*min|next hour|within (?:the|an) hour|this hour/.test(text)) return 'hour';
  return 'soonest';
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

/** "Did I win my last trade? / what's my win rate? / how's my loss rate?" — a read
 *  of the trader's SETTLED track record. `last` = the most recent settled bet's
 *  result; `win_rate` / `loss_rate` = the running rate over settled bets. Defers to
 *  close_position when it's an imperative to close/redeem (so "close my last bet"
 *  isn't swallowed). "win rate"/"loss rate" are inherently personal on this venue,
 *  so they don't require a first-person cue; the bare "last bet" branch does. */
function trackRecordFrom(text: string): { focus: 'last' | 'win_rate' | 'loss_rate'; ask?: 'win' | 'lose' } | null {
  // An imperative to act on a position belongs to close_position, not a read.
  if (/\bclose\b|\bredeem\b|cash ?out|\bclaim\b|\bsell\b|\bexit\b|\bcollect\b|\bclear\b/.test(text)) return null;
  const mine = /\bmy\b|\bi\b|\bi'?ve\b|\bam i\b|\bdid i\b|\bhave i\b|\bdo i\b/.test(text);
  // Most recent settled bet's result.
  if (
    /\b(?:my |the )?last (?:trade|bet|prediction|position|one|call)\b/.test(text) &&
    (mine || /\b(?:win|won|winning|lose|lost|losing|result|profit|pnl|go|going|do|doing|turn out)\b/.test(text))
  ) {
    // Track which way they asked so the answer's yes/no matches the question: "did I
    // lose?" on a bet that WON must lead with "No", not "Yes". Neutral when neither
    // (or both) side is named (e.g. "how did my last bet go").
    const lose = /\b(?:lose|lost|losing)\b/.test(text);
    const win = /\b(?:win|won|winning)\b/.test(text);
    return { focus: 'last', ask: lose && !win ? 'lose' : win && !lose ? 'win' : undefined };
  }
  // Loss rate — checked before win so "win/loss rate" or a loss-focused ask lands here.
  if (/\bloss rate\b|\blosing rate\b|how often do i lose|\bmy loss(?:es)?\b|loss (?:%|percent(?:age)?)/.test(text)) return { focus: 'loss_rate' };
  // Win rate.
  if (/\bwin ?rate\b|\bwinrate\b|\bwinning rate\b|win (?:%|percent(?:age)?)|how often do i win|\bmy wins?\b|\bhow many.*\b(?:win|won)\b/.test(text)) return { focus: 'win_rate' };
  return null;
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
  return /\bvolatility\b|\bvolatile\b|how big (?:a |of a )?move|(?:big|large|expected|likely) move|move (?:that'?s |is )?priced in|priced[- ]in move|expected (?:range|move|swing)|how much (?:could|will|might|can) (?:btc|it|price) (?:move|swing)/.test(text);
}

/** "Crash or pump? / which tail is bigger?" — the surface's skew/shape. */
function wantsSkew(text: string): boolean {
  return /\bskew\b|crash or pump|pump or crash|bracing for|(?:bigger|more) (?:on the )?(?:downside|upside)|downside.{0,10}upside|upside.{0,10}downside|tail risk|priced for a (?:crash|drop|pump|rally)|fear(?:ing)? a (?:crash|drop)/.test(text);
}

/** "Any mispricings? / is the surface arb-free?" — the no-arb checker. ("right" is
 *  the "is it correct?" sense; guard it so "is the surface right NOW" — a volatility
 *  ask — doesn't get caught here.) */
function wantsNoArb(text: string): boolean {
  return /arbitrage|no[- ]?arb|arb[- ]?free|mispric|is the surface (?:ok|healthy|clean|arb|fair|right(?! now))|surface (?:healthy|clean|broken|glitch)/.test(text);
}

/** "Which strike has the most volume? / busiest strike? / where's the action?" —
 *  needs a volume/activity cue AND a strike/level (or surface) cue, so it doesn't
 *  fire on "biggest move" (that's volatility) or a bare "volume". */
function wantsBusiestStrike(text: string): boolean {
  const volumeCue = /\bbusiest\b|\bhottest\b|most (?:traded|active|popular|bet on|volume|action|bets)|\bmost volume\b|where.{0,20}(?:action|money|volume|bets|flow)|\bmost bets?\b/.test(text);
  const strikeCue = /\bstrikes?\b|\bprice level\b|which (?:strike|level|price)|on the surface|\bfrom the surface\b/.test(text);
  return volumeCue && strikeCue;
}

/** "How's the volume on the surface? / how busy is it? / how much is being bet?" —
 *  the OVERALL activity read (total staked + up/down split + busiest spot), distinct
 *  from `busiest_strike` (which names one level). A bare volume/activity cue with no
 *  "which strike" is enough; busiest_strike is matched first, so "where's the volume"
 *  still names the level. Not the trader's own book. */
function wantsSurfaceVolume(text: string): boolean {
  if (/\bmy (?:bet|position|trade|money|stake|volume)\b/.test(text)) return false;
  return /\bvolume\b|\bhow (?:busy|active)\b|\bhow much (?:is )?(?:being )?(?:traded|bet|staked|going (?:on|through))\b|\b(?:much|any|lots? of|a lot of) (?:activity|action|trading|betting)\b|\bis it (?:busy|active|quiet|dead)\b|how'?s (?:the )?(?:activity|action)\b/.test(text);
}

/** "What can I bet on? / how many markets? / how far out can I bet? / what
 *  timeframes?" — the surface's shape: how many live expiries and their range.
 *  About the markets, not the trader's own book. */
function wantsMarketsOverview(text: string): boolean {
  if (/\bmy\b/.test(text)) return false; // "my markets/bets" is the portfolio
  return /\bwhat can i (?:bet|trade|play) on\b|\bhow many (?:markets?|expiries|expiry|timeframes?)\b|\bhow far (?:out|ahead|forward)\b|\bwhat (?:markets?|expiries|timeframes?|timescales?) (?:are (?:there|available|open|live|up)|can i|do i|do you)\b|\bwhat timeframes?\b|\blist (?:the )?(?:markets?|expiries)\b|\bwhat'?s (?:available|open) to bet\b/.test(text);
}

/** "Where's the biggest payout? / the longest shot? / a moonshot?" — the highest
 *  mintable payout multiple on the surface. Requires a superlative + a payout noun
 *  (so a bare "longshot up bet" stays a directional bet, not this). */
function wantsBiggestPayout(text: string): boolean {
  return /\b(?:biggest|highest|largest|longest|best|max(?:imum)?)\s+(?:payout|multiplier|multiple|return|reward|win|shot)\b|\bmoon ?shot\b|\blongest shot\b|\bmost i can (?:win|make|earn)\b|\bbiggest (?:gamble|risk|degen)\b/.test(text);
}

/** "Close my up bet / cash out / redeem my winnings / close the 65k one" — a
 *  request to close or redeem one of the trader's own positions. Needs a close/
 *  redeem cue AND a reference to a position (so "how long until it closes" — no
 *  imperative "close" — doesn't fire). */
function wantsClose(text: string): { all?: boolean; winnings?: boolean; dir?: BetDirection; strike?: number } | null {
  // "close" as the close-VERB, not the adjective ("how close is it", "close to X").
  const closeVerb = /\bclose\b/.test(text) && !/\bhow close\b|\bclose (?:to|is|are|enough|call|by)\b/.test(text);
  // "clear" the position (esp. a LOST bet, whose action reads "Clear" not "Redeem"),
  // not the adjective ("is that clear", "clear enough", "clear it up").
  const clearVerb = /\bclear\b/.test(text) && !/\b(?:is|are|it'?s|that|this|make[sn]?)\s+(?:it |that |this )?clear\b|\bclear (?:up|enough|sky|skies)\b|\bcrystal clear\b/.test(text);
  const cue = closeVerb || clearVerb || /\bredeem\b|cash ?out|\bclaim\b|\bsell\b|\bcollect\b|\bexit\b|get out|take (?:my )?(?:profit|winnings|money)|take profits?/.test(text);
  if (!cue) return null;
  // Standalone claim verbs imply "my stuff"; "close"/"sell"/"exit" need a position
  // reference (a strike, a side, or my/it/this/bet/…) so "close to the money" or
  // "how close is it" don't fire.
  const strong = /\bredeem\b|\bclaim\b|cash ?out|\bcollect\b/.test(text);
  const level = levelFrom(text);
  const strike = level?.kind === 'strike' ? level.price : undefined;
  const dir = dirFrom(text);
  const ref = strong || strike != null || dir != null || /\b(my|it|this|that)\b|\bposition|\bbet\b|\btrade\b|winnings?|\ball\b|everything|\bwins?\b|profits?/.test(text);
  if (!ref) return null;
  const winnings = /winnings?|\bwins?\b|\bprofits?\b|\bwinners?\b|what i won|my gains?/.test(text) || undefined;
  const all = /\ball\b|everything|every (?:bet|position|trade)/.test(text) || undefined;
  return { winnings, all, dir, strike };
}

/** Conversational tweak to the CURRENT bet — "make it $10", "use 3x", "change the
 *  strike to 65,500", "flip to down", "other side". Returns the fields to change,
 *  or null when there's no modification cue. Checked between the explicit "set up a
 *  trade" phrases and the trade-param branch, so "make it 3x" edits (not restarts).
 *  A number with an `x` reads as leverage; `$`/`dusdc` as stake; a strike-word or a
 *  4+ digit "move it to N" as the strike. */
function adjustFrom(raw: string): { stake?: number; leverage?: number; strike?: number; dir?: BetDirection; flip?: boolean } | null {
  const out: { stake?: number; leverage?: number; strike?: number; dir?: BetDirection; flip?: boolean } = {};

  if (/\bflip\b|\breverse\b|other side|opposite side|switch sides|other (?:way|direction)|opposite direction/.test(raw)) out.flip = true;
  // A change to a named side. Accepts the plain-word synonyms ("change it to below",
  // "make it above") and edit verbs ("edit"/"reverse"/"turn") so flipping direction
  // stays an EDIT of the current ticket (keeps its stake + leverage) instead of
  // falling through to a brand-new default bet.
  // "move" is deliberately NOT an edit verb here — it's the noun for price movement
  // ("a 1% move up"), so it stays with the reality-check / volatility reads.
  const toDir =
    raw.match(/\b(?:flip|switch|change|make|go|turn|edit)\b[^.?!]{0,16}\b(up|down|above|below|higher|lower|long|short)\b/) ??
    raw.match(/\b(up|down|above|below|higher|lower)\b(?: bet)? instead/);
  if (toDir) out.dir = /^(?:up|above|higher|long)$/.test(toDir[1]) ? 'up' : 'down';

  const lev = raw.match(/\b(?:leverage|lev)\s*(?:to|of|is|=|:|at)?\s*(\d+(?:\.\d+)?)\s*x?\b/) ?? raw.match(/\b(\d+(?:\.\d+)?)\s*x\b/);
  if (lev) out.leverage = parseFloat(lev[1]);

  const strike = raw.match(/\bstrike\s*(?:to|=|:|at|of)?\s*\$?(\d[\d,]{3,}(?:\.\d+)?)/) ?? raw.match(/\bmove (?:it|the strike|this) to \$?(\d[\d,]{3,}(?:\.\d+)?)/);
  if (strike) out.strike = parseFloat(strike[1].replace(/,/g, ''));

  // Stake — not a strike number (4+ digits already taken), not the leverage number.
  const stakeM =
    raw.match(/\b(?:make it|bet|stake|amount|wager|risk|size)\s*(?:to|of|=|:)?\s*\$(\d[\d,]*(?:\.\d+)?)/) ??
    raw.match(/\b(?:make it|stake|amount|wager|risk|bet)\s*(?:to|of|=|:)?\s*(\d[\d,]*(?:\.\d+)?)\b(?!\s*x)/) ??
    raw.match(/\$(\d[\d,]*(?:\.\d+)?)\b/) ??
    raw.match(/\b(\d[\d,]*(?:\.\d+)?)\s*dusdc\b/);
  if (stakeM && out.strike == null) {
    const n = parseFloat(stakeM[1].replace(/,/g, ''));
    if (!(out.leverage != null && n === out.leverage)) out.stake = n;
  }

  const cue = /\bmake it\b|\bchange\b|\bset\b|\bswitch\b|\bflip\b|\breverse\b|\bturn\b|\bedit\b|\buse\b|\bmove\b|\binstead\b|\bbump\b|\bincrease\b|\bdecrease\b|\blower\b|\braise\b|other side|other (?:way|direction)|make the/.test(raw);
  const has = out.flip || out.dir != null || out.leverage != null || out.strike != null || out.stake != null;
  return cue && has ? out : null;
}

/** "What's the best value? / where's the value? / which strike is underpriced?" —
 *  find where the surface's price underrates the real chance. Keyed on value words
 *  only (not "best odds", which is the term-structure "which market" question). */
function wantsBestValue(text: string): boolean {
  return /\bbest value\b|\bgood value\b|\bvalue (?:bet|play|strike|pick)\b|where('?s| is) (?:the )?value|\bunder ?priced\b|\bover ?priced\b|\bbest bet\b|\bmost value\b|\bcheapest (?:bet|strike)\b/.test(text);
}

/** "How's everyone positioned? / is the crowd long or short? / buy or sell pressure?
 *  / what's smart money doing?" — the perps positioning + order-flow read (Clawby PRO). */
function wantsPositioning(text: string): boolean {
  return /\bpositioning\b|\bpositioned\b|long\s*\/\s*short|long[- ]short ratio|\bthe crowd\b|smart money|(?:big|top|large|whale)\s*traders?|order flow|(?:buy(?:ing|ers)?|sell(?:ing|ers)?)\s*(?:vs\.?|versus|or)\s*(?:sell(?:ing|ers)?|buy(?:ing|ers)?)|(?:buy|sell)(?:ing)?\s*pressure|(?:who|everyone|people|most people|are (?:traders|people|they|longs|shorts)).{0,18}\b(?:long|short|buying|selling|positioned)\b/.test(text);
}

/** "Are institutions buying? / ETF flow? / is money coming in?" — institutional flow. */
function wantsFlow(text: string): boolean {
  return /\betfs?\b|institution(?:s|al)?|\binflows?\b|\boutflows?\b|net flow|fund flow|spot etf|(?:are|is)\s+(?:institutions|whales|the whales|big money)\s+(?:buying|selling|accumulating|dumping)|(?:money|capital)\s+(?:coming in|flowing in|leaving|flowing out|pouring in)/.test(text);
}

/* ------------------------------ onboarding ------------------------------- */
// The first-run journey: get the trading account created, and get some test
// tokens to trade with. Matched on the RAW text (before the "set up" strip) and
// checked BEFORE the info intents, so "get me some dusdc" triggers the airdrop
// rather than the static funds explainer.

/** "Create my trading account / open an account / set up my account." Requires an
 *  action verb + "account", so "what's a trading account" (a question) isn't caught. */
function wantsCreateAccount(text: string): boolean {
  return /\b(?:create|open|set ?up|make|start|register|activate|need|want|get)\b[^?]{0,20}\b(?:trading )?account\b/.test(text);
}

/** "Get test tokens / airdrop / faucet / fund my account / give me DUSDC." An
 *  ACQUISITION cue (get/give/claim/fund/airdrop/faucet), so "how much DUSDC do I
 *  have" (balance) and "what is DUSDC" (explain) are not swept in. */
function wantsGetTokens(text: string): boolean {
  return /\bairdrop\b|\bfaucet\b|\btest (?:tokens?|dusdc|money|funds|coins?)\b|\bfree (?:tokens?|dusdc|money|coins?)\b|\b(?:get|give|send|grab|claim|need|want|drip)\b[^?]{0,16}\b(?:dusdc|tokens?|test funds|test money)\b|\bfund (?:my )?(?:account|wallet)\b|\btop ?up\b[^?]{0,12}\b(?:account|wallet|balance)\b|\bstarter grant\b/.test(text);
}

/** "How do I get started / onboard me / new here / where do I begin." The general
 *  first-run guidance (state-aware). Kept narrow so "how does this work" stays the
 *  explainer. */
function wantsOnboarding(text: string): boolean {
  return /\bget started\b|\bgetting started\b|\bonboard(?:ing| me)?\b|\bnew here\b|\bnew to (?:this|predict|trading|the app)\b|\bhow (?:do i|to) (?:get )?start(?:ed)?\b|\bwhere do i (?:start|begin)\b|\bhelp me (?:get )?start\b|\bfirst time\b|\bwhat do i need to (?:start|trade|bet)\b/.test(text);
}

/** "What's the options market saying? / put-call ratio? / options positioning?" */
function wantsOptionsMarket(text: string): boolean {
  return /options? (?:market|flow|positioning|sentiment|book|traders?)|put[- ]?call|call[- ]?put|p\s*\/\s*c ratio|what.{0,25}options.{0,15}(?:say|saying|tell|think)|options.{0,12}(?:bullish|bearish|lean|leaning)/.test(text);
}

/** A live move/direction cue ("pumping", "dropping", "up", "red") and a market
 *  subject ("btc", "price") — the two ingredients of a causal "why" question. */
const MOVE_CTX = /\b(?:mov(?:e|ing|ed)|pump(?:ing)?|dump(?:ing)?|drop(?:ping)?|fall(?:ing)?|ris(?:e|ing)|rally(?:ing)?|crash(?:ing)?|tank(?:ing)?|surg(?:e|ing)|spik(?:e|ing)|sell(?:ing|off| off)?|\bup\b|\bdown\b|\bred\b|\bgreen\b)\b/;
const MARKET_SUBJ = /\b(?:btc|bitcoin|price|market|crypto)\b/;

/** "Why is BTC moving? / what's driving this? / any news? / why the dump?" — the
 *  CAUSAL question (what's behind the move + what people are discussing), distinct
 *  from the plain "read the market" (which stays `analyze`, so "what's happening
 *  with bitcoin" isn't swallowed). Never about the trader's own book. */
function wantsWhyMoving(text: string): boolean {
  if (/\bmy (?:bet|position|trade|money|stake)\b/.test(text)) return false;
  // "why is it so volatile" — a causal "why" about the volatility (what's driving
  //  the swings), distinct from "how volatile is it" (the magnitude), which asks
  //  the surface's expected move and stays `volatility`.
  if (/\bwhy\b/.test(text) && /\bvolatil/.test(text)) return true;
  const causal =
    /what'?s (?:driving|behind|causing|moving)\b/.test(text) ||
    /what (?:is|'s) (?:driving|behind|causing|moving|the reason|the catalyst)\b/.test(text) ||
    /what (?:caused|moved|drove)\b/.test(text) ||
    /\breason (?:for|behind) (?:the|this|that|btc|bitcoin|it|price)\b/.test(text) ||
    /\bwhat'?s the news\b|\bany (?:news|catalyst)\b|\bis there (?:any )?news\b|breaking news/.test(text) ||
    /\bwhy the (?:dump|pump|drop|rally|crash|sell-?off|move|spike|red|green|tank|fall|surge)\b/.test(text);
  if (causal) return true;
  // A "why …" question that names a move word or a market subject.
  const whyMove = /\bwhy\b/.test(text) && (MOVE_CTX.test(text) || /\bhappening\b|going on/.test(text));
  return whyMove && (MARKET_SUBJ.test(text) || MOVE_CTX.test(text));
}

/** "Right now / currently / live" → the single live market; otherwise every open
 *  expiry. (The user's rule: a "now"-style cue scopes to the current market.) */
function busiestScope(text: string): 'now' | 'all' {
  return /\bnow\b|right now|currently|at the moment|\blive\b|at present/.test(text) ? 'now' : 'all';
}

/** "How does X work? / what's a range bet? / what if I lose?" — a conceptual
 *  question we answer from a plain-language glossary (no live data). Needs a
 *  question frame AND a known topic keyword, so it never swallows a data question
 *  ("what's the funding rate" stays a metric). */
function explainTopic(text: string): ExplainTopic | null {
  if (!/\bwhat\b|\bhow\b|\bexplain\b|tell me|\bwhy\b|meaning|difference|point of|what if|\bdo you\b|\bcan (?:i|you)\b|\bis (?:this|it|there)\b|\bdo i\b|\bare (?:there|the|these)\b/.test(text)) return null;
  if (/\bleverage\b|knock ?out/.test(text)) return 'leverage';
  if (/\brange bet\b|\ba range\b|range market|range work/.test(text)) return 'range';
  if (/(?:up|down) bet (?:mean|work|is|do)|what.{0,14}(?:up|down) bet|\bbinary\b|up ?\/ ?down/.test(text)) return 'binary';
  if (/settl(?:e|es|ed|ing|ement|ements)|how.{0,14}(?:expir|close)|when.{0,14}(?:it |they )?(?:pay|resolve)/.test(text)) return 'settlement';
  if (/if i lose|lose more|lose my|can i lose|what.{0,10}(?:happens|the).{0,14}los|\blosing\b/.test(text)) return 'loss';
  if (/\bfees?\b|\bcommission\b|how do you (?:make|earn) money|(?:make|makes) money|\brevenue\b|cost to (?:trade|bet)|\bcharge/.test(text)) return 'fees';
  if (/\bdusdc\b|\bfaucet\b|testnet (?:funds|money|tokens|dusdc)|get (?:some )?(?:dusdc|funds|tokens|test)|free (?:dusdc|tokens|money)|what.{0,10}currency|real money/.test(text)) return 'funds';
  if (/\bpayout\b|how.{0,14}(?:win|paid|payout)|how much.{0,16}win|what do i win|\bodds mean\b/.test(text)) return 'payout';
  if (/what (?:is|'s) (?:this|predict|deepbook)|how does (?:this|it|predict) work|what can you do|how do i (?:start|begin|bet|trade)/.test(text)) return 'predict';
  return null;
}

/** "Find / show / locate the $64,730 strike on the surface" — a request to LOCATE
 *  a specific strike (so we can light it up), not build or analyze one. Needs a
 *  find-style cue AND a concrete strike price. */
function wantsFindStrike(text: string): { price: number; dir?: BetDirection } | null {
  if (!/\bfind\b|\bshow\b|\blocate\b|\bhighlight\b|\bwhere('?s| is)\b|point (?:me )?(?:to|out|at)|take me to|\bgo to\b|\bmark\b|pull up|bring up|\bdisplay\b|\bpick\b|\bchoose\b|\bselect\b|\bsearch\b/.test(text)) return null;
  // A sizing token (leverage / amount) means it's a trade SETUP, not a locate —
  // let it fall through to the wizard rather than just lighting the strike up.
  if (/\bleverage\b|\b\d+(?:\.\d+)?\s*x\b|\b\d[\d,]*\s*dusdc\b/.test(text)) return null;
  const level = levelFrom(text);
  if (!level || level.kind !== 'strike') return null;
  return { price: level.price, dir: dirFrom(text) };
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
  // "Find/show me the X strike" → locate it on the surface. Checked BEFORE the
  // trade-param branch so "find the strike at 64,730" isn't read as building one.
  const find = wantsFindStrike(raw);
  if (find) return { kind: 'find_strike', price: find.price, dir: find.dir };
  // Start the guided wizard on an explicit "set up a trade"-style phrase, on raw
  // text — it must beat the NON_DIRECTIONAL strip (which would remove "set up").
  if (has(raw, START_TRADE_PHRASES)) return { kind: 'start_trade' };
  // A tweak to the CURRENT bet ("make it $10", "use 3x", "flip to down") — between
  // the explicit-phrase check and TRADE_PARAM, so "make it 3x" edits rather than
  // restarting the wizard (TRADE_PARAM would otherwise claim the "3x").
  const adjust = adjustFrom(raw);
  if (adjust) return { kind: 'adjust_ticket', ...adjust };
  // Explicit trade params ("strike 66000, 2x, 6 dusdc") → build a fresh trade.
  if (TRADE_PARAM.test(raw)) return { kind: 'start_trade' };

  // Onboarding actions, matched on RAW text (before the "set up" strip below would
  // remove "set up my account") and before the info intents (so "get me dusdc"
  // triggers the airdrop, not the funds explainer). Create-account first (most
  // specific), then get-tokens, then the general get-started guidance.
  if (wantsCreateAccount(raw)) return { kind: 'create_account' };
  if (wantsGetTokens(raw)) return { kind: 'get_tokens' };
  if (wantsOnboarding(raw)) return { kind: 'onboarding' };

  const text = raw.replace(NON_DIRECTIONAL, ' ');

  const up = has(text, UP_WORDS);
  const down = has(text, DOWN_WORDS);
  const wantsAnalysis = has(text, ANALYZE_WORDS);
  const wantsBet = has(text, BET_WORDS);

  // "What are the odds at $X / of a Y% move?" — a chance question. Checked before
  // the directional branch because "odds BTC ABOVE $67k" carries a side word.
  const odds = oddsFrom(text);
  if (odds) return { kind: 'odds', ...odds, horizon: horizonFrom(text) };

  // "Which strike has the most volume?" — a distinct volume-by-strike ask. Before
  // the other surface questions so "most volume" isn't misread as "biggest move".
  if (wantsBusiestStrike(text)) return { kind: 'busiest_strike', scope: busiestScope(text) };
  if (wantsSurfaceVolume(text)) return { kind: 'surface_volume', scope: busiestScope(text) };
  // "What can I bet on?" (the surface's expiries) and "biggest payout / longshot"
  // (the highest mintable multiple) — before best_value so a "biggest payout" ask
  // isn't read as "best value".
  if (wantsMarketsOverview(text)) return { kind: 'markets_overview' };
  if (wantsBiggestPayout(text)) return { kind: 'biggest_payout' };
  // "What's the best value?" — before term_structure so "which is the best value"
  // isn't caught by its "which market … best" pattern.
  if (wantsBestValue(text)) return { kind: 'best_value' };

  // Positioning & flow (Clawby PRO): the crowd/smart-money/order-flow read, the
  // institutional ETF flow, and the options market. BEFORE the surface + directional
  // branches, since "long/short" and "buying/selling" carry direction words that
  // aren't a bet. Options-market first (most specific), then flow, then positioning.
  if (wantsOptionsMarket(text)) return { kind: 'options_market' };
  if (wantsFlow(text)) return { kind: 'flow' };
  if (wantsPositioning(text)) return { kind: 'positioning' };

  // "Why is BTC moving? / what's driving this? / any news?" — the causal read.
  // Before the surface + directional + analyze branches, since it carries move and
  // direction words ("dumping", "up") that aren't a bet, and "moving" is an analyze
  // cue we want to beat when the question is explicitly asking WHY.
  if (wantsWhyMoving(text)) return { kind: 'why_moving' };

  // "Did I win my last trade? / win rate / loss rate" — the trader's settled track
  // record. Checked EARLY (before reality_check's "how often", and the directional /
  // portfolio branches) since "how often do i win" and "my last trade" carry cues
  // those would otherwise claim. Defers to close_position via its own close-verb guard.
  const rec = trackRecordFrom(text);
  if (rec) return { kind: 'track_record', focus: rec.focus, ...(rec.ask ? { ask: rec.ask } : {}) };

  // Surface-native analysis (vol / skew / term / no-arb / reality check). Before
  // the directional branch too — "crash or pump" carries both sides, "1m or 5m for
  // up" and "how often does a 1% move up happen" carry one.
  if (wantsNoArb(text)) return { kind: 'no_arb' };
  if (wantsSkew(text)) return { kind: 'skew' };
  if (wantsVolatility(text)) return { kind: 'volatility' };
  if (wantsTermStructure(text)) return { kind: 'term_structure', dir: dirFrom(text) };
  if (wantsRealityCheck(text)) return { kind: 'reality_check', level: levelFrom(text) ?? undefined, dir: dirFrom(text) };
  // "Analyse the current/this strike" — a focused read of the selected strike,
  // before the plain analyze cue (which "analyse" would otherwise trigger). If the
  // trader named a strike ("analyse 64,500 strike"), carry it so we read THAT one,
  // not whatever's currently selected.
  if (wantsStrikeAnalysis(text)) {
    const lvl = levelFrom(text);
    const price = lvl?.kind === 'strike' ? lvl.price : undefined;
    const dir = dirFrom(text);
    return { kind: 'analyze_strike', ...(price != null ? { price } : {}), ...(dir ? { dir } : {}) };
  }

  // "Close my up bet / redeem my winnings / cash out the 65k" — act on the trader's
  // own positions. Before the directional branch, since "close my up bet" carries a
  // side word that isn't a new bet.
  const close = wantsClose(text);
  if (close) return { kind: 'close_position', ...close };

  // Focused data questions — how the trader's own book is doing, a single metric
  // ("fear & greed", "how much is BTC up today"), or the balance. BEFORE the
  // directional branch, since "am I up" / "up today" carry a direction word that
  // isn't a bet. Portfolio (performance + funds) beats the funds-only balance.
  if (wantsPortfolio(text)) return { kind: 'portfolio' };
  const metric = metricFrom(text);
  if (metric) return { kind: 'metric', metric };
  if (wantsBalance(text)) return { kind: 'balance' };

  // "How does leverage work? / what's a range bet? / what if I lose?" — a glossary
  // answer. AFTER the specific data questions (so "how much dusdc do I have" stays
  // balance) but before the plain analyze read (which "what is" would trigger).
  const topic = explainTopic(text);
  if (topic) return { kind: 'explain', topic };

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
