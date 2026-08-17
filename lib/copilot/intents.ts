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

import { isMeaningfulMemory } from './memory-quality';

export type Conviction = 'safe' | 'even' | 'longshot';
export type Horizon = 'soonest' | 'hour' | 'today';
export type BetDirection = 'up' | 'down';
/** What a memory-recall question is asking for: the trader's name, their trading
 *  style/preferences, or an open "what do you remember about me". */
export type RecallSubject = 'name' | 'style' | 'general';
/** A single market metric the trader can ask about directly — answered with a
 *  focused one/two-liner instead of the full market read. */
export type MetricKind = 'fear_greed' | 'funding' | 'liquidations' | 'max_pain' | 'price' | 'change_24h' | 'open_interest';

/** A price level to quote odds at: an absolute strike, or a % move from spot. */
export type OddsLevel = { kind: 'strike'; price: number } | { kind: 'move'; pct: number };
/** The horizon of a calendar/events question: today's lineup, or the week / month
 *  ahead. Defaults to `today` when the question names no window. */
export type EventRange = 'today' | 'week' | 'month';
/** An explicit target on a directional bet: a win-chance (70%) or a payout (3×). */
export type BetTarget = { kind: 'prob'; value: number } | { kind: 'payout'; mult: number };
/** A "how does X work?" topic the co-pilot can explain in plain language. The first
 *  row is Skew's own mechanics; the second is newcomer options + product vocabulary
 *  (mapped onto Skew's plain UP/DOWN framing) for people who don't know the surface. */
export type ExplainTopic =
  | 'leverage' | 'range' | 'binary' | 'settlement' | 'loss' | 'fees' | 'funds' | 'payout' | 'predict'
  | 'option' | 'call_put' | 'strike' | 'expiry' | 'implied_vol' | 'premium' | 'moneyness' | 'surface' | 'vault'
  // Product FAQ about Skew itself (not options vocabulary): how the leaderboard Points
  // work, whether funds are safe (custody), and the rewards program.
  | 'points' | 'safety' | 'rewards';

export type CopilotIntent =
  | { kind: 'analyze' }
  | { kind: 'analyze_strike'; price?: number; dir?: BetDirection }
  | { kind: 'next_market' }
  | { kind: 'start_trade' }
  | { kind: 'metric'; metric: MetricKind }
  | { kind: 'recommend' }
  // "What range should I trade in? / recommend a range / a safe range band" — Kelly
  // recommends a price band to bet stays-inside, sized off the surface's expected
  // move. `conviction` widens (safer) or tightens (longshot) the band.
  | { kind: 'range_bet'; conviction: Conviction; horizon: Horizon }
  | { kind: 'balance' }
  | { kind: 'portfolio' }
  | { kind: 'track_record'; focus: 'last' | 'win_rate' | 'loss_rate'; ask?: 'win' | 'lose' }
  // "How am I doing on the leaderboard? / where do I rank? / what do I need to do to
  // climb?" — the trader's OWN standing + personalized advice, read from their board
  // row. Distinct from the mechanism explainer (explain→points, "how do points
  // work"). `focus` leads with the current position ('status') or the fastest way up
  // ('improve').
  | { kind: 'leaderboard_standing'; focus: 'status' | 'improve' }
  | { kind: 'odds'; level: OddsLevel; dir?: BetDirection; horizon?: Horizon }
  | { kind: 'reality_check'; level?: OddsLevel; dir?: BetDirection }
  | { kind: 'volatility' }
  | { kind: 'skew' }
  | { kind: 'term_structure'; dir?: BetDirection }
  | { kind: 'no_arb' }
  // "Why does the surface LOOK like this?" — a live read of the CURRENT shape
  // (height / tilt / front-to-back slope), distinct from the definitional
  // explain→surface ("what is the surface").
  | { kind: 'surface_shape' }
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
  // "What's happening today? / any events this week? / anything on the calendar
  // this month?" — the scheduled market-moving calendar from Clawby. `range` picks
  // the horizon: today's lineup, or the upcoming week / month.
  | { kind: 'events'; range: EventRange }
  // Onboarding: get-started guidance, create the trading account, get test tokens.
  | { kind: 'onboarding' }
  | { kind: 'create_account' }
  | { kind: 'get_tokens' }
  // "Add 10 DUSDC to the vault / supply the liquidity pool" — deposit into the vault
  // (async LP). `amount` is the DUSDC to queue (undefined → Kelly asks how much).
  | { kind: 'vault_deposit'; amount?: number }
  // "Remember that I ..." → store a durable memory (Kelly's Walrus-backed memory);
  // `text` is the fact to save. "What do you remember about me?" → recall saved memories.
  | { kind: 'remember'; text?: string }
  | { kind: 'recall_memory'; query?: string; subject?: RecallSubject }
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
// "Set up a trade / open a trade / walk me through it" — start the guided step-by-
// step wizard. Matched on the RAW text before the "set up"→UP stripping below. The
// "<verb> a trade/bet/position" phrasings are safe next to a direction word: a
// "safe up" between the verb and object breaks the contiguous match, so a
// directional request ("open a safe up bet") still routes to a one-shot suggestion.
const START_TRADE_PHRASES = [
  'set up a trade', 'set up trade', 'setup a trade', 'set up my trade', 'set up a bet', 'set up a position',
  'open a trade', 'open a bet', 'open a position', 'open my trade',
  'start a trade', 'start a bet', 'start a position',
  'new trade', 'new bet', 'new one',
  // "Open another one" after a trade (or an expired wizard) = start a fresh setup.
  'another trade', 'another bet', 'another one', 'set up another', 'open another',
  'start another', 'one more trade', 'one more bet',
  'enter a trade', 'enter a bet', 'put on a trade',
  'build a trade', 'build a bet', 'create a trade', 'create a bet',
  'make a trade', 'make a bet', 'place a trade', 'place a bet',
  'walk me through', 'guide me', 'step by step', 'help me set up', 'help me place', 'guided trade',
];
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

/** "What range should I trade in? / recommend a range / a safe range to bet / build
 *  me a tight range" — asks Kelly to RECOMMEND a price band, not to explain what a
 *  range bet is (that stays the glossary). Requires the "range" noun plus an action
 *  or "what/which range" phrasing; the definitional asks are excluded up front. */
function wantsRangeBet(text: string): boolean {
  // Personal book / definitional asks belong to other intents.
  if (/\bmy (?:range|bet|position|trade)\b/.test(text)) return false;
  if (!/\brange\b/.test(text)) return false;
  // "up or down or range?" is a directional STEER (→ recommend), naming range as one
  // option among the sides, not a request to size a specific band. Bail when both
  // sides are named, or on the explicit "or range" either/or phrasing.
  if (/\bor range\b/.test(text) || (/\bup\b/.test(text) && /\bdown\b/.test(text))) return false;
  // "what is a range bet? / how do range bets work?" stays a glossary answer.
  if (/what(?:'?s| is| are)?\b[^?]{0,14}\ba range\b|how (?:do(?:es)?|to)\b[^?]{0,20}\brange\b/.test(text)) return false;
  return (
    /\bwhat range\b|\bwhich range\b|\brange should i\b|\bshould i\b[^?]{0,24}\brange\b/.test(text) ||
    /\b(?:recommend|suggest|pick|choose|give me|show me|set up|find|build|best|good|ideal|safe|wide|tight|narrow)\b[^?]{0,18}\brange\b/.test(text) ||
    /\brange\b[^?]{0,18}\b(?:to (?:trade|bet|play|pick)|bet on|trade)\b/.test(text) ||
    /\btrade\b[^?]{0,12}\brange\b/.test(text)
  );
}

/** How wide a recommended range should be, as a Conviction the reply maps to a
 *  multiple of the expected move. "wide" reads as safer (more likely to contain the
 *  settlement), "tight/narrow" as a longshot; otherwise the shared safe/longshot cues. */
function rangeWidthFrom(text: string): Conviction {
  if (/\b(?:wide|wider|widest)\b/.test(text)) return 'safe';
  if (/\b(?:tight|tighter|narrow|narrower|precise)\b/.test(text)) return 'longshot';
  return convictionFrom(text);
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
  // `(?:open |live |current |running )?` lets "how's my OPEN trade" / "show my open
  // position" reach the portfolio read — checking a live position is the most common
  // way people phrase it, and without it "my open trade" slips past to analyze/help.
  return (
    /\bportfolio\b|\bmy (?:open |live |current |running )?(?:positions?|bets?|trades?|holdings?|pnl|p&l|profit|performance|book|gains?|losses?)\b|how (?:am i|'?m i|are (?:my|things)|is my (?:portfolio|book|account|trading))|am i (?:up|down|winning|losing|in profit|making money|losing money)|how('?s| is| are) (?:my|the) (?:open |live |current |running )?(?:portfolio|bets?|trades?|positions?)|how are (?:my )?(?:open |live |current |running )?(?:bets?|trades?|positions?) (?:doing|performing|going)/.test(
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
 * A "place the bet now" confirmation, optionally carrying a stake and/or leverage
 * OVERRIDE to apply to the bet Kelly just suggested: "trade it", "place it with 1
 * dusdc", "do it, 5 dusdc at 2x". Returns the overrides (`{}` when none) when the
 * message confirms, or `null` when it doesn't.
 *
 * The line between this and a NEW trade spec ("trade 66000, 2x, 6 dusdc" →
 * start_trade): a confirmation REFERENCES the pending bet ("trade IT", "place
 * THIS", a bare "yes"/"do it"), so any numbers are tweaks to THAT bet, not a fresh
 * order. A spec that names a strike/side without an "it/this/the bet" anchor is not
 * a confirm. A question ("should I trade it?") and a long ramble are not either.
 */
export function placeConfirmation(message: string): { stake?: number; leverage?: number } | null {
  const t = message.toLowerCase().trim().replace(/[’]/g, "'").replace(/[.!?]+$/, '');
  if (!t) return null;
  if (t.split(/\s+/).length > 10) return null; // confirmations are short, not rambles
  // A question is not a confirmation ("should I trade it", "do you think I should
  // place it"). "do it" (a confirm) is spared — only "do i/we/you …" bails.
  if (/^(?:should|shall|can|could|would|does|is|are|was|were|what|which|how|why|when|will|might|worth)\b/.test(t)) return null;
  if (/^do (?:i|we|you)\b/.test(t)) return null;
  // A message that names the vault / liquidity pool is a DEPOSIT request (handled by
  // the vault_deposit intent), not a confirmation of the pending BET — so "put 10
  // dusdc in the vault" never places a trade. (A trade confirm never names the vault.)
  if (/\bvault\b|liquidity pool|\bliquidity\b|\blps?\b|\bplp\b|\bthe pool\b/.test(t)) return null;

  // "<verb> it/this/that/(the|my) bet/trade/position" — the object keeps a bare
  // "trade 66000" (a new spec) from matching. Plus standalone affirmations.
  const refConfirm = /\b(?:trade|place|open|send|do|lock|buy|book)\s+(?:it|this|that|(?:the |my )?(?:bet|trade|position|order))\b/.test(t);
  const bareConfirm = /^(?:yes|yep|yeah|yup|ok|okay|sure|confirm|do it|go|go for it|let'?s go|lets go|send it|lock it in|place it|trade it|open it)\b/.test(t);
  // "trade with 1 dusdc" / "place 5 dusdc" / "bet $10 at 2x" — a confirm VERB led
  // straight into a SIZE (a dusdc stake, a $ amount, or an Nx leverage): the same
  // sizing tweak as "trade IT with 1 dusdc", just without the "it" anchor. This is
  // the very common way people confirm ("trade with 1 dusdc"), so it must place the
  // pending bet, not fall through to start a fresh wizard / navigate. Only counts
  // when it names NO strike and NO side — a strike or a direction makes it a new
  // spec (parseIntent → start_trade owns those); a plain size is a confirm.
  const namesStrike = /\b\d[\d,]{3,}(?:\.\d+)?\b(?!\s*(?:x\b|dusdc\b))/.test(t);
  const namesSide = has(t, UP_WORDS) || has(t, DOWN_WORDS);
  const sizedConfirm =
    !namesStrike &&
    !namesSide &&
    /^(?:trade|place|open|send|lock|buy|book|bet|stake|put|go)\b/.test(t) &&
    /\$\d|\b\d[\d,]*(?:\.\d+)?\s*dusdc\b|\b\d+(?:\.\d+)?\s*x\b/.test(t);
  if (!refConfirm && !bareConfirm && !sizedConfirm) return null;

  // Optional stake / leverage overrides for the pending bet. Leverage is read from
  // either order — "leverage 2" / "lev 2x", "2x leverage" / "2 leverage", or a bare
  // "2x" — so "trade it with 1 dusdc and 2x leverage" lands lev 2, stake 1.
  const out: { stake?: number; leverage?: number } = {};
  const lev =
    t.match(/\b(?:leverage|lev)\s*(?:to|of|is|at|=|:)?\s*(\d+(?:\.\d+)?)\s*x?\b/) ??
    t.match(/\b(\d+(?:\.\d+)?)\s*x?\s*(?:leverage|lev)\b/) ??
    t.match(/\b(\d+(?:\.\d+)?)\s*x\b/);
  if (lev) out.leverage = parseFloat(lev[1]);
  const stakeM =
    t.match(/\b(\d[\d,]*(?:\.\d+)?)\s*dusdc\b/) ??
    t.match(/\bwith\s+\$?(\d[\d,]*(?:\.\d+)?)\b/) ??
    t.match(/\$(\d[\d,]*(?:\.\d+)?)\b/) ??
    t.match(/\b(?:stake|bet|amount|risk|size|for)\s+\$?(\d[\d,]*(?:\.\d+)?)\b/);
  if (stakeM) {
    const n = parseFloat(stakeM[1].replace(/,/g, ''));
    if (!(out.leverage != null && n === out.leverage)) out.stake = n; // don't read "2x" as a $2 stake
  }
  return out;
}

/**
 * A short "place the bet now" confirmation ("trade it", "place it", "yes", "do it")
 * — the typed equivalent of tapping the review card's Trade it / Place this bet
 * button. Now just asks whether `placeConfirmation` matched (which ALSO accepts an
 * inline stake/leverage — "trade it with 1 dusdc"); callers that want the override
 * use `placeConfirmation` directly.
 */
export function isPlaceConfirmation(message: string): boolean {
  return placeConfirmation(message) !== null;
}

/**
 * Read a bet SIZE out of a reply that is basically just an amount — the answer to
 * Kelly's "how much do you want to bet?". Accepts "50", "$50", "50 dusdc",
 * "bet 10", "make it 30", "about 25 please". Returns the DUSDC amount, or null when
 * the message isn't an amount (so the caller can treat it as a normal message). A
 * bare leverage like "2x" is NOT an amount, so it returns null.
 */
export function parseAmountReply(message: string): number | null {
  const t = message.toLowerCase().trim().replace(/[,$]/g, '');
  if (!t) return null;
  const stripped = t
    .replace(/^(?:i(?:'|')?ll |i want to |i wanna |let'?s |make it |do |bet |stake |put |use |go |with |for |about |around |maybe )+/g, '')
    .trim();
  const m = stripped.match(/^(\d+(?:\.\d+)?)\s*(?:dusdc|dollars?|bucks)?\.?\s*(?:please|thanks?)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pull an explicit DUSDC amount named ANYWHERE in a request ("set up a $50 up
 * trade", "up bet 20 dusdc", "bet 10 up"). Requires a money marker ($ / dusdc / a
 * stake verb) so a 4-5 digit STRIKE (66000) or a leverage (2x) is never mistaken
 * for a stake. Returns null when no amount is named, which is the signal for Kelly
 * to ASK how much rather than assume. Used to capture the size from the request so
 * a trader who did say "$50" isn't asked again.
 */
export function extractStake(message: string): number | null {
  const t = message.toLowerCase().replace(/,/g, '');
  const m =
    t.match(/\$(\d+(?:\.\d+)?)(?!\s*x)\b/) ??
    t.match(/\b(\d+(?:\.\d+)?)\s*dusdc\b/) ??
    t.match(/\b(?:bet|stake|staking|risk|wager|put)\s+\$?(\d+(?:\.\d+)?)(?!\s*x)\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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

/** "Why does the surface look like this? / why is it so steep / tilted / lopsided?
 *  / what's up with the surface shape?" — a live read of the surface's CURRENT
 *  APPEARANCE (its height, tilt, and front-to-back slope). Distinct from the
 *  definitional "what is the surface" (that stays the explainer): this REQUIRES an
 *  appearance/shape cue, which a bare "what is the surface" doesn't have. Anchored
 *  on the word "surface" so it never fires on an unrelated "why is it steep". */
function wantsSurfaceShape(text: string): boolean {
  if (!/\bsurface\b/.test(text)) return false;
  // A shape / appearance cue — the thing that separates "why does it LOOK like
  // this" from the definitional "what is the surface" (which has no such cue).
  const appearance =
    /\blook(?:s|ing)?\b|\bshaped?\b|\blike (?:this|that)\b|\bthis way\b|\bthe way it (?:does|looks|is)\b|\bsteep(?:er)?\b|\bskewed?\b|\btilt(?:ed|ing)?\b|\blopsided\b|\bleaning?\b|\bslop(?:e|es|ed|ing)\b|\bcurv(?:e|ed|y)\b|\bbent\b|\bwavy\b|\bjagged\b|\bhump(?:ed)?\b|\bflat\b|\bdip(?:s|ping|ped)?\b|\bspik(?:e|es|ing|ed|y)\b|\bwarped\b|\bweird\b|\bstrange\b|\bodd\b|\bfunny\b|\boff\b|\bdifferent\b|\bcrazy\b|\buneven\b|\bshape\b|\bbright\b|\bglow(?:ing|y)?\b|\bcolou?rful\b|\bred\b|\bgreen\b/.test(
      text,
    );
  if (!appearance) return false;
  // A "why", a "what does it look like", a "what's with", or an explain/read cue.
  return (
    /\bwhy\b/.test(text) ||
    /\bwhat(?:'?s| is| does| are)\b/.test(text) ||
    /\bhow come\b/.test(text) ||
    /\bexplain\b|\bread (?:me )?(?:the )?surface\b|make sense of/.test(text)
  );
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

/** "Add 10 DUSDC to the vault / deposit into the liquidity pool / supply the pool /
 *  provide liquidity" — a request to DEPOSIT into the vault (async LP), which Kelly
 *  proposes and the trader confirms + signs. Requires a deposit verb AND a
 *  vault/LP/pool destination, and is NOT a withdrawal (those fall through — there's
 *  no withdraw intent yet). Pulls the amount when one's given. The definitional
 *  "what is the vault" has no deposit verb, so it still routes to the glossary. */
function wantsVaultDeposit(text: string): { amount?: number } | null {
  // Name the vault / liquidity pool / LP as the destination.
  if (!/\bvault\b|liquidity pool|\bliquidity\b|\blps?\b|\bplp\b|\bthe pool\b/.test(text)) return null;
  // A withdrawal / cancel is a different action (no intent for it yet) — let it fall through.
  if (/\bwithdraw\b|\bremove\b|\bpull\b|\btake out\b|\bunstake\b|\bredeem\b|\bcancel\b|\bexit\b/.test(text)) return null;
  // A deposit action verb.
  if (!/\b(?:add|deposit|put|supply|provide|contribute|top ?up|throw|move|send|stake|lend|fund|invest|park)\b/.test(text)) return null;
  return { amount: vaultAmount(text) };
}

/** Pull a DUSDC amount from a vault-deposit message: prefers a "N dusdc" / "$N"
 *  figure, else the first plain number. Undefined when none is named (Kelly then
 *  asks how much). */
function vaultAmount(text: string): number | undefined {
  const m =
    text.match(/\$?(\d[\d,]*(?:\.\d+)?)\s*(?:dusdc|dollars?|bucks?|usd)\b/) ??
    text.match(/\$(\d[\d,]*(?:\.\d+)?)/) ??
    text.match(/\b(\d[\d,]*(?:\.\d+)?)\b/);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
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

/** "What's happening today? / any events? / is there FOMC or CPI today? / anything
 *  on the calendar?" — the day's SCHEDULED market-moving events. Distinct from the
 *  plain "what's happening" market read (that stays `analyze`): the generic
 *  what's-happening phrasing only routes here when anchored to a day, but a named
 *  macro event (FOMC / CPI / rate decision) or explicit calendar language is enough
 *  on its own. Never about the trader's own book. */
function wantsEvents(text: string): boolean {
  if (/\bmy (?:bet|position|trade|money|stake|pnl|p&l)\b/.test(text)) return false;
  // Named macro events / explicit calendar language — a strong signal on its own.
  if (/\bfomc\b|\bcpi\b|\bpce\b|\bnfp\b|\bnonfarm\b|\bjobs report\b|\bpowell\b|(?:interest )?rate (?:decision|hike|cut|meeting)|economic (?:calendar|data|events?)|\bmacro (?:calendar|events?|data)\b|market[- ]moving/.test(text)) return true;
  const day = HORIZON_CUE.test(text);
  // A calendar/events noun that's being asked about.
  if (/\b(?:any|what|which|the)\b[^?]{0,16}\bevents?\b/.test(text)) return true;
  if (/on (?:the )?(?:calendar|docket|agenda)/.test(text)) return true;
  if (/\b(?:events?|calendar|docket|agenda|scheduled?)\b/.test(text) && day) return true;
  // "what's happening / went on / anything happen(ed) big", but ONLY when anchored
  // to a horizon, so the plain "what's happening" market read still routes to `analyze`.
  if (
    new RegExp(`\\b(?:what'?s|whats|what is|what are|anything|any big|is there anything)\\b[^?]{0,24}${HORIZON_CUE.source}`).test(text) &&
    /\b(?:happen(?:ed|ing|s)?|going on|big|important|scheduled?|planned|calendar|events?)\b/.test(text)
  )
    return true;
  // "What happened today / this week?" — a bare recap ask with no "events" noun;
  // horizon-anchored so it doesn't swallow the plain market read. Routes to events
  // (the calendar + the day's news headline) instead of dead-ending at help.
  if (new RegExp(`\\bwhat\\b[^?]{0,20}\\bhappen(?:ed|ing|s)?\\b[^?]{0,16}${HORIZON_CUE.source}`).test(text)) return true;
  return false;
}

/** The time-window cues that anchor an events question (today / week / month), so
 *  a generic "what's happening" only routes to the calendar when scoped to one.
 *  Kept in one place so `wantsEvents` and `eventsRange` agree on what counts. */
const HORIZON_CUE = /\b(?:today|tonight|this week|next week|week ahead|this month|month ahead|coming (?:up|days?|weeks?)|upcoming|on tap|rest of (?:the )?(?:week|month))\b/;

/** Which horizon an events question is asking about. Month cues win over week over
 *  today, so "events this week and month" leans to the wider month view. Defaults
 *  to today when no window is named. */
export function eventsRange(text: string): EventRange {
  if (/\bthis month\b|\bmonth ahead\b|\bcoming weeks?\b|\bnext few weeks\b|\bthe month\b|\brest of (?:the )?month\b|\bmonthly\b/.test(text)) return 'month';
  if (/\bthis week\b|\bnext week\b|\bweek ahead\b|\bcoming (?:up|days?|week)\b|\bupcoming\b|\bon tap\b|\brest of (?:the )?week\b/.test(text)) return 'week';
  return 'today';
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
  if (/\brange bets?\b|\ba range\b|range market|range work/.test(text)) return 'range';
  if (/(?:up|down) bet (?:mean|work|is|do)|what.{0,14}(?:up|down) bet|\bbinary\b|up ?\/ ?down/.test(text)) return 'binary';
  if (/settl(?:e|es|ed|ing|ement|ements)|how.{0,14}(?:expir|close)|when.{0,14}(?:it |they )?(?:pay|resolve)/.test(text)) return 'settlement';
  if (/if i lose|lose more|lose my|can i lose|what.{0,10}(?:happens|the).{0,14}los|\blosing\b/.test(text)) return 'loss';
  if (/\bfees?\b|\bcommission\b|how do you (?:make|earn) money|(?:make|makes) money|\brevenue\b|cost to (?:trade|bet)|\bcharge/.test(text)) return 'fees';
  if (/\bdusdc\b|\bfaucet\b|testnet (?:funds|money|tokens|dusdc)|get (?:some )?(?:dusdc|funds|tokens|test)|free (?:dusdc|tokens|money)|what.{0,10}currency|real money/.test(text)) return 'funds';
  if (/\bpayout\b|how.{0,14}(?:win|paid|payout)|how much.{0,16}win|what do i win|\bodds mean\b/.test(text)) return 'payout';
  if (/what (?:is|'s) (?:this|predict|deepbook)|how does (?:this|it|predict) work|what can you do|how do i (?:start|begin|bet|trade)/.test(text)) return 'predict';
  return null;
}

/**
 * Newcomer glossary for options + product vocabulary, mapped onto Skew's plain
 * UP/DOWN framing, for people who don't yet know the surface. Fires ONLY on a
 * definitional lead ("what is X", "how does X work", "explain X"), so a live-data
 * ask ("what's the volatility right now", "what's the skew") has no definitional
 * cue and falls through to its own intent below. "How does Skew work"-style product
 * questions reuse the existing `predict` explainer. Kept ahead of the live vol/skew/
 * term reads in parseIntent so a plain "what is …" wins.
 */
function conceptGlossary(text: string): ExplainTopic | null {
  const asks =
    /\bwhat\b|\bhow\b|\bexplain\b|\bdefine\b|\bmeaning\b|\bdifference\b|tell me|\beli5\b|\bnew to\b|don'?t (?:know|understand|get)|never (?:used|heard|traded)|point of/.test(
      text,
    );
  if (!asks) return null;

  // Options vocabulary.
  if (/what (?:is|are|'?s) (?:an? )?(?:call|put)s?\b|\b(?:call|put)s? (?:option|bet)\b|\bcall\b[^?]{0,14}\bput\b|\bput\b[^?]{0,14}\bcall\b|difference between (?:a )?(?:call|put)/.test(text)) return 'call_put';
  if (/implied vol|what (?:is|are|'?s|does) (?:implied )?vol|vol(?:atility)?\b[^?]{0,20}\bmean\b|what[^?]{0,16}(?:volatility|vol)\b[^?]{0,16}(?:number|percent|%|figure)|understand[^?]{0,10}vol/.test(text)) return 'implied_vol';
  if (/(?:what (?:is|are|'?s|does)|explain|meaning of) (?:an? |the )?strike|strike (?:price)?\b[^?]{0,10}\bmean\b/.test(text)) return 'strike';
  if (/(?:what (?:is|are|'?s|does)|explain|meaning of) (?:an? |the )?expir|expir\w*[^?]{0,12}\bmean\b|how (?:do|does) (?:an? )?expir\w* work/.test(text)) return 'expiry';
  if (/(?:what (?:is|are|'?s|does)|explain|meaning of) (?:the |a |an |option )?premium\b|premium\b[^?]{0,10}\bmean\b/.test(text) && !/coinbase|\betf\b|grayscale/.test(text)) return 'premium';
  if (/in the money|out of the money|at the money|\bitm\b|\botm\b|moneyness/.test(text)) return 'moneyness';
  if (/what (?:is|are|'?s) (?:an? )?options?\b|how (?:do|does) (?:an? )?options? work|options? explained|understand (?:btc )?options/.test(text)) return 'option';

  // How Skew works (product) + the surface + the pool. Definitional only, so a live
  // ask that merely names the surface ("how volatile is the surface now") falls
  // through to the volatility read.
  if (/(?:what (?:is|are|'?s|does)|explain|meaning of) (?:the )?surface|how (?:do|does|to)[^?]{0,14}(?:read|use)[^?]{0,14}(?:surface|chart|graph|map)|how (?:does|do) (?:the )?surface work|3 ?-? ?d (?:chart|graph|map|surface)|(?:chart|graph|map) on the left/.test(text)) return 'surface';
  if (/(?:what (?:is|are|'?s|does)|explain|meaning of|how (?:does|do)) (?:the )?vault|liquidity pool|who pays (?:winners|me|out)|where[^?]{0,16}(?:payout|winnings|money)[^?]{0,10}come/.test(text)) return 'vault';
  if (/how (?:does|do|can) (?:skew|this|it|you|the app|the site) work|what (?:is|'?s) skew\b|what[^?]{0,12}skew (?:app|do|about|is)|what makes skew|why (?:use )?skew|what can you do|what (?:is|'?s) this (?:app|thing|platform|site)|how (?:do i|to) use (?:this|skew|it)/.test(text)) return 'predict';

  return null;
}

/**
 * Product FAQ about Skew itself — how the leaderboard Points work, whether funds are
 * safe (custody), and the rewards program. Unlike `conceptGlossary` this is NOT gated on
 * a "what/how" lead: people ask these bare ("leaderboard points", "is my money safe"),
 * and it must be matched EARLY so the funds/points wording doesn't get grabbed by the
 * balance / portfolio reads first. Returns the explainer topic, else null.
 */
function productFaq(text: string): ExplainTopic | null {
  // Leaderboard / points / ranks — how they accumulate. Plural `points` (or leaderboard
  // /ranks/climb) only, so the ask-cue "point of …" ("what's the point of leverage")
  // never trips it.
  if (/\bpoints\b|\bleaderboard\b|leader ?board|\bpoint system\b|\brankings?\b|\branks\b|climb.{0,16}(?:rank|board|leaderboard)/.test(text)) {
    return 'points';
  }
  // Custody / is it safe / non-custodial. Deliberately NOT bare "safe" (that's the
  // conviction word in "safe up bet") — needs a money/wallet/custody/scam anchor.
  if (/\bnon-?custodial\b|\bcustod(?:y|ial)\b|\brug(?: ?pull)?\b|\bscams?\b|\blegit\b|(?:is|are)\s+(?:it|this|skew|my (?:money|funds|wallet|crypto))\s+safe\b|\bsafe to (?:use|trade|connect|sign)\b|do (?:you|they|skew)\s+(?:hold|keep|store|control|touch|have|own)\s+my\s+(?:money|funds|wallet|keys|crypto|coins)|(?:hold|keep|control|store|touch)\s+my\s+(?:funds|money|keys|wallet|crypto)|can\s+(?:you|skew|anyone)\s+(?:take|steal|access|touch|move|drain)\s+my|access to my (?:wallet|funds|money|keys)/.test(text)) {
    return 'safety';
  }
  // Quests / competitions / rewards (airdrop/faucet asks are handled earlier by
  // get_tokens, so they never reach here).
  if (/\bquests?\b|\bcompetitions?\b|\btournaments?\b|\brewards? (?:program|work|system)\b|\bwhat.{0,12}rewards?\b|\bprizes?\b|degen arena|\bfactions?\b/.test(text)) {
    return 'rewards';
  }
  return null;
}

/**
 * A PERSONAL leaderboard question — "how am I doing on the board", "where do I
 * rank", "what do I need to do to climb / rank higher / do better". Distinct from
 * the mechanism explainer (productFaq → 'points', "how do points work"): that one
 * has no first-person cue. Requires a board/rank/points/standing anchor AND a
 * first-person cue, so "how does the leaderboard work" stays a mechanism ask and
 * falls through. Returns 'improve' for a how-to-get-better ask, else 'status'.
 */
function wantsLeaderboardStanding(text: string): 'status' | 'improve' | null {
  // Plural `points` (like productFaq) so "what's the point of leverage" never trips
  // it; plus the board / rank / standing / score words.
  const anchor =
    /\bpoints\b|\bleaderboard\b|leader ?board|\branks?\b|\brankings?\b|\bstandings?\b|\bscore\b|where i stand|climb.{0,16}(?:rank|board|leaderboard)/.test(
      text,
    );
  if (!anchor) return null;
  // "how am I", "my rank", "where do I stand" — a first-person cue is what separates a
  // personal standing ask from the generic mechanism explainer.
  if (!/\b(?:i|i'?m|im|my|mine|me|we|our|us)\b/.test(text)) return null;
  // A how-to-improve ask: an improvement verb, or a "what do I need / should I do" lead.
  const improve =
    /\b(?:improve|climb|climbing|move up|moving up|rank up|ranking up|level up|do better|doing better|perform better|get (?:higher|ahead|better)|go higher|going higher|push (?:up|higher)|boost|earn more|more points|reach the top|get to the top)\b/.test(
      text,
    ) || /\bwhat (?:do|should|can|would) (?:i|we) (?:need|have|do|gotta|got to)\b/.test(text);
  return improve ? 'improve' : 'status';
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
 * "What do you remember / know about me?" → recall the trader's saved memories. A
 * question form, never a store: "what have you learned about me", "what do you know
 * about me", "do you remember me", "my saved preferences" all hit.
 */
function wantsRecallMemory(raw: string): { query?: string } | null {
  if (/\bdo you remember\b/.test(raw)) return {};
  const memoryVerb = /\b(remember|know|learned|memor(?:y|ies|ized)|saved|stored)\b/.test(raw);
  const aboutMe = /\b(about|of) me\b/.test(raw);
  const myMemory = /\bmy (saved )?(preferences|memories|memory|notes|profile|style)\b/.test(raw);
  const question = /\b(what|which|do you|did you|have you|anything)\b/.test(raw);
  if (memoryVerb && (aboutMe || myMemory) && question) return {};
  return null;
}

/**
 * Classify a memory-recall question so Kelly answers it directly from her saved memory:
 *  - a DIRECT name question ("what is my name", "who am I") → subject 'name'
 *  - a style/preference question ("what's my trading style", "how do I like to trade",
 *    "what style do I like using for trading") → subject 'style'
 *  - the open "what do you remember about me / my saved preferences" → subject 'general'
 * Returns null for anything that isn't asking about the trader themselves (so market
 * questions like "what's the best bet" are never swallowed). The `query` steers the
 * semantic recall toward the right memory; the reply is built by recallReplyLines.
 */
function classifyRecall(raw: string): { subject: RecallSubject; query?: string } | null {
  if (
    /\bwhat(?:'?s| is|s)?\s+my\s+name\b/.test(raw) ||
    /\bwho\s+am\s+i\b\s*\??$/.test(raw) ||
    /\b(?:do|did)\s+you\s+(?:know|remember|recall)\s+(?:what\s+)?my\s+name\b/.test(raw)
  ) {
    return { subject: 'name', query: 'the trader’s name' };
  }
  if (
    /\bwhat(?:'?s| is| are)?\s+my\s+(?:trading\s+)?(?:style|preferences?|prefs|habits?|tendenc(?:y|ies))\b/.test(raw) ||
    /\bwhat\s+style\b[^?]*\bi\b/.test(raw) ||
    /\bhow\s+do\s+i\s+(?:like\s+to\s+)?(?:trade|bet|play)\b/.test(raw) ||
    /\bwhat\s+(?:kind|type|sort)\s+of\s+(?:bets?|trades?|markets?)\s+do\s+i\b/.test(raw) ||
    /\bwhat\s+do\s+i\s+(?:like|prefer)\s+to\s+(?:trade|bet)\b/.test(raw)
  ) {
    return { subject: 'style', query: 'the trader’s trading style, direction lean, and risk preference' };
  }
  if (wantsRecallMemory(raw)) return { subject: 'general' };
  return null;
}

/**
 * "Remember that I ..." / "note that I ..." / "keep in mind ..." → store a durable memory.
 * Returns the fact with ORIGINAL casing (from `message`, not the lowercased raw) so it
 * reads back naturally. Question forms are excluded (those recall). Requires at least two
 * words after the verb, so a bare "remember me" doesn't store a junk fact.
 */
function wantsRemember(message: string): { text?: string } | null {
  const t = message.trim();
  const lower = t.toLowerCase();
  if (/^(what|which|do you|did you|have you|can you)\b/.test(lower)) return null; // a question → recall
  const m = lower.match(/\b(?:remember|note|keep in mind|don'?t forget)\b(?:\s+(?:that|this)\b)?[:,]?\s*(.+)/);
  if (!m) return null;
  const factStart = (m.index ?? 0) + m[0].length - m[1].length;
  const fact = t.slice(factStart).trim().replace(/[.?!]+$/, '');
  if (!fact || fact.split(/\s+/).length < 2) return null;
  return { text: fact };
}

/** Words that follow "I'm …" but are never a name (trading/mood terms), so "I'm bullish"
 *  or "I'm ready" is not stored as a name. Compared lowercased. */
const NON_NAME = new Set([
  'bullish', 'bearish', 'up', 'down', 'long', 'short', 'in', 'out', 'back', 'here', 'done',
  'new', 'not', 'ready', 'good', 'fine', 'okay', 'ok', 'sure', 'looking', 'trying', 'thinking',
  'betting', 'feeling', 'going', 'holding', 'buying', 'selling', 'watching', 'confident',
  'nervous', 'curious', 'later', 'soon', 'tomorrow', 'now', 'still', 'just', 'confused',
  'interested', 'bored', 'winning', 'losing', 'set', 'about',
]);

function cleanName(s: string): string {
  const t = s.replace(/[.,!?'’"]+$/, '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Pull the trader's NAME out of a message they use to introduce themselves, so Kelly can
 * greet them by it. Two tiers:
 *  - Explicit ("my name is X", "call me X", "name's X", "I'm called X") → accepted unless the
 *    word is a known non-name.
 *  - Loose ("I'm X" / "I am X") → accepted only when X reads like a name (Capitalized + not a
 *    trading/mood term), so "I'm bullish" or "I'm ready" never becomes a name.
 * Returns the name with a capitalized first letter, or null. Pure + unit-tested.
 */
export function extractName(message: string): string | null {
  const t = message.trim();
  let m = t.match(/\b(?:my name is|name['’]?s|call me|i(?:'|’)?m called)\s+([A-Za-z][\w'’.-]{1,23})/i);
  if (m) {
    const name = cleanName(m[1]);
    if (name && !NON_NAME.has(name.toLowerCase())) return name;
  }
  m = t.match(/\bi(?:'|’)?m\s+([A-Za-z][\w'’.-]{1,23})\b/i) ?? t.match(/\bi am\s+([A-Za-z][\w'’.-]{1,23})\b/i);
  if (m && /^[A-Z]/.test(m[1]) && !NON_NAME.has(m[1].toLowerCase())) return cleanName(m[1]);
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
  // "Add 10 DUSDC to the vault / supply the liquidity pool" → a vault deposit Kelly
  // proposes (the trader confirms + signs). BEFORE the trade branches so the amount
  // ("10 dusdc") isn't read as a bet, and before adjust/TRADE_PARAM which would
  // claim the number. The definitional "what is the vault" has no deposit verb, so
  // it still falls through to the glossary.
  const vault = wantsVaultDeposit(raw);
  if (vault) return { kind: 'vault_deposit', ...(vault.amount != null ? { amount: vault.amount } : {}) };
  // A question about the trader themselves ("what is my name", "what's my trading style",
  // "what do you remember about me?") → recall saved memories and answer it. "Remember that
  // I ..." → store one. Checked here (a read/command about Kelly's memory) before the trade
  // branches so "remember I like safe bets" isn't mis-read as a bet. Recall (a question) is
  // tested before the store so "what do you remember about me" never stores.
  const recall = classifyRecall(raw);
  if (recall) return { kind: 'recall_memory', subject: recall.subject, ...(recall.query ? { query: recall.query } : {}) };
  // A name introduction ("my name is Degendev", "I'm Degendev") stores a clean "your name is
  // X" fact. Checked BEFORE wantsRemember so "My name is X, remember that" captures the name,
  // not the dangling "that" after "remember" (which had stored a junk fragment).
  const name = extractName(message);
  if (name) return { kind: 'remember', text: `your name is ${name}` };
  // Only store a "remember that …" tail that actually carries content — never a filler
  // fragment like "from now" / "for later" (the loose parse would otherwise keep it).
  const remember = wantsRemember(message);
  if (remember?.text && isMeaningfulMemory(remember.text)) return { kind: 'remember', text: remember.text };
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

  // Personal leaderboard questions ("how am I doing on the board?", "what do I need
  // to do to climb?") → the standing answer, which reads the trader's own board row.
  // BEFORE productFaq so its points/leaderboard wording doesn't get claimed by the
  // mechanism explainer; the bare "how do points work" asks have no first-person cue
  // and fall through to productFaq below.
  const standing = wantsLeaderboardStanding(raw);
  if (standing) return { kind: 'leaderboard_standing', focus: standing };

  // Product FAQ about Skew (leaderboard points, custody/safety, rewards). EARLY — the
  // "points"/"my money"/"funds" wording would otherwise be claimed by the balance /
  // portfolio reads below, and these are answered from a static explainer either way.
  const faq = productFaq(raw);
  if (faq) return { kind: 'explain', topic: faq };

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

  // "Why does the surface LOOK like this? / why so steep / tilted?" — a live read
  // of the current shape. BEFORE the glossary, because the glossary's definitional
  // "what does the surface …" pattern would otherwise swallow "what does the
  // surface look like now"; the shape read requires an appearance cue that the
  // definitional "what is the surface" lacks, so that one still falls through. Run
  // on RAW text so "what's up with the surface shape" survives (the NON_DIRECTIONAL
  // strip removes "what's up", which would drop the interrogative).
  if (wantsSurfaceShape(raw)) return { kind: 'surface_shape' };

  // "What range should I trade in? / recommend a range" — a RANGE recommendation
  // (a price band to bet stays-inside), sized off the surface's expected move.
  // BEFORE the glossary (so "recommend a range" isn't read as the definitional
  // "what's a range bet") and before recommend/analyze (which "should i" trips).
  // wantsRangeBet excludes the definitional asks, so those still fall to the glossary.
  if (wantsRangeBet(text)) return { kind: 'range_bet', conviction: rangeWidthFrom(text), horizon: horizonFrom(text) };

  // Newcomer glossary ("what's a call option?", "what is implied volatility?", "how
  // does Skew work?"). BEFORE the live vol/skew/term reads so a definitional "what
  // is …" wins, while a live ask ("what's the volatility now") has no definitional
  // cue and falls through to them. AFTER the options-market/flow block so "what do
  // options traders say" stays a live read.
  const concept = conceptGlossary(text);
  if (concept) return { kind: 'explain', topic: concept };

  // "What's happening today? / any events? / is there FOMC?" — today's scheduled
  // calendar. Before why_moving + analyze, since "happening today" trips the
  // analyze cue and a named event should beat the causal/plain reads.
  // Range reads from RAW text: NON_DIRECTIONAL strips "coming up" out of `text`,
  // which would otherwise hide that horizon cue.
  if (wantsEvents(text)) return { kind: 'events', range: eventsRange(raw) };

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

/** Read/question intents a trader might fire in the MIDDLE of the guided trade
 *  wizard. When one lands mid-setup we ANSWER it and keep the trade paused,
 *  instead of mis-reading it as a flow answer (a price/direction) or forcing a
 *  cancel. Deliberately PURE informational reads only: nothing that suggests or
 *  edits a bet (so the half-built trade isn't clobbered), nothing async, and
 *  none of the wizard's own answer words — bare numbers / "up" / "down" parse to
 *  `help` or `directional_bet`, neither of which is here, so they still feed the
 *  wizard. See the screen's handleSend for how this pauses vs advances the flow. */
const FLOW_INTERRUPT_KINDS: ReadonlySet<CopilotIntent['kind']> = new Set<CopilotIntent['kind']>([
  'analyze', 'why_moving', 'events', 'positioning', 'flow', 'options_market',
  'volatility', 'skew', 'metric', 'reality_check', 'explain', 'no_arb',
  'term_structure', 'surface_shape', 'markets_overview', 'balance', 'portfolio', 'track_record',
]);

/** True when `intent` is a question we should answer mid-wizard, pausing (not
 *  cancelling) the trade setup. See FLOW_INTERRUPT_KINDS. */
export function isFlowInterruption(intent: CopilotIntent): boolean {
  return FLOW_INTERRUPT_KINDS.has(intent.kind);
}
