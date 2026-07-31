/**
 * lib/copilot/respond.ts — the Predict co-pilot's responder: given a parsed
 * intent and the live market data the screen already holds, produce a plain-
 * language reply and (for a bet) a concrete, mintable suggestion.
 *
 * It reuses the machinery we already trust rather than inventing anything:
 *   • buildMarketRead / directionStance  → the plain-language market read + lean
 *   • strikeForDirectionFair (v2 grid)   → conviction → a real, snapped strike
 *   • directionFair / payoutMultiple     → the honest odds + payout at that strike
 * So even this rule-based version never invents a number — it restates what the
 * surface and Clawby already say, in words. Swapping in an LLM later replaces the
 * router, not this data path (the LLM would call these same functions as tools).
 *
 * Pure and side-effect free (no fetch, no React), so it's unit-tested. It does
 * NOT place anything: it returns a suggestion the UI loads into the ticket, and
 * the trader still reviews and signs. Plain language is a hard rule (no jargon).
 */
import { num, pct, signed, compact } from '@/lib/format';
import { toFloat, fromFloat, fromQuote, toQuote } from '@/config/scale';
import { quantityForStake, winPayout, leverageSliderMax } from '@/lib/sui/v2/quote';
import { buildMarketRead, directionStance, recommendation } from '@/lib/insights/market-read';
import { analyzeStrike, strikeVerdict } from '@/lib/insights/strike-analysis';
import { positioningLines, flowLines, optionsLines } from '@/lib/insights/positioning-read';
import { buildNarrative } from '@/lib/insights/narrative';
import { buildEventsReply, notableEvents, eventName, relTime } from '@/lib/insights/events';
import type { Positioning } from '@/lib/insights/positioning';
import type { NarrativeFeed } from '@/lib/insights/narrative';
import type { EventsFeed } from '@/lib/insights/events';
import { strikeForDirectionFair } from '@/lib/sui/v2/invert';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { upFair, totalVariance } from '@/lib/svi/svi';
import { buildSurface, type SmileInput } from '@/lib/svi/surface';
import { directionFair, payoutMultiple } from '@/lib/svi/invert';
import { buildLadder } from '@/lib/markets/v2-ladder';
import type { PortfolioSummary } from '@/lib/portfolio/v2';
import type { WinStats, PastPrediction } from '@/lib/portfolio/history';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { CopilotIntent, Conviction, BetDirection, Horizon, MetricKind, OddsLevel, BetTarget, ExplainTopic } from './intents';

const usd = (v: number) => `$${compact(v)}`;

/** A market we can actually price (has a live pricer → forward + SVI). */
export interface BetCandidate {
  market: V2Market;
  pricer: LivePricer;
}

export interface CopilotContext {
  insights: BtcInsights | null;
  /** Positioning & flow (Clawby PRO) — crowd/smart-money/pressure, ETF flow, and
   *  the options market. Null until it loads (or when the page is gated). */
  positioning?: Positioning | null;
  /** The "what is X talking about?" chatter aggregate (Clawby PRO x_search), for
   *  the "why is BTC moving?" answer. Carries the `ai` seam a later Claude slice
   *  fills. Null until it loads (or when the page is gated). */
  narrative?: NarrativeFeed | null;
  /** Today's scheduled market-moving calendar (macro events + a news headline),
   *  for "what's happening today?". Clawby-backed; null until it loads (or gated). */
  events?: EventsFeed | null;
  candidates: BetCandidate[];
  now: number;
  /** Live BTC spot ($) — the SAME feed the top price tape shows. Used only for
   *  the user-facing "BTC is around $X now" text, so the co-pilot's current-price
   *  figure never disagrees with the tape. Pricing/strike math still uses each
   *  market's on-chain `forward` (a different feed the protocol settles against).
   *  Falls back to the forward when spot isn't loaded yet. */
  spot?: number | null;
  /** The connected account's DUSDC, for a "what's my balance?" answer. Read from
   *  the same `usePredictAccountV2` the ticket uses. Base units (@6-dec).
   *  `walletBase` is undefined while it's still loading. */
  wallet?: {
    connected: boolean; // a wallet is connected
    hasAccount: boolean; // a trading account (wrapper) exists
    accountBase: bigint; // DUSDC sitting in the trading account
    walletBase: bigint | undefined; // DUSDC in the plain wallet
    /** True ONLY for a brand-new, near-empty wallet the app can still auto-fund:
     *  the starter grant is one-time and gated on no trading account yet + a DUSDC
     *  balance under the ceiling (the server also handles the SUI-for-gas drip).
     *  When false the treasury would reject the grant, so we offer the faucet
     *  instead of a doomed drip. Computed in the screen (mirrors the trade ticket). */
    grantEligible?: boolean;
  } | null;
  /** Every live expiry's smile (the same inputs the 3-D surface is built from),
   *  for the no-arb check. Needs ≥2 expiries. */
  surfaceInputs?: SmileInput[];
  /** 1-minute BTC closes (oldest → newest), for the empirical reality check. */
  closes?: number[] | null;
  /** The trader's own book roll-up, for "how is my portfolio doing?" — computed
   *  from the SAME positions the Portfolio screen shows. Null until it loads. */
  portfolio?: PortfolioSummary | null;
  /** The trader's settled track record (win rate, streak, realized PnL) + their most
   *  recent settled bet — for "did I win my last trade / what's my win rate". Derived
   *  from useV2History in the screen's isolated open-bets subtree (so the surface
   *  never subscribes to it). Null until it loads. */
  record?: { stats: WinStats; lastTrade: PastPrediction | null } | null;
  /** What the ticket is currently on, for "analyse the current strike" and for
   *  conversational tweaks ("make it $10"). The responder finds this market in
   *  `candidates` for its pricer. `stake`/`leverage` are the current ticket values. */
  selection?: { marketId: string; strikePrice: number; isUp: boolean; stake?: number; leverage?: number } | null;
}

/** The "current BTC price" to SHOW the trader — the tape's spot when we have it,
 *  else the market's forward. Display only; never feed this into the odds math. */
function nowPrice(ctx: CopilotContext, pricer: LivePricer): number {
  return ctx.spot ?? pricer.forward;
}

/** A concrete, mintable bet the UI loads into the trade store (highlight + ticket). */
export interface BetSuggestion {
  marketId: string;
  expiry: number;
  dir: BetDirection;
  isUp: boolean;
  /** Float admission-grid price the ticket pins to. */
  strikePrice: number;
  /** Honest odds at the snapped strike (0..1). */
  prob: number;
  /** What $1 returns if it wins. */
  payoutMult: number;
  conviction: Conviction;
  timeLeftLabel: string;
  /** Set only by the guided wizard (lib/copilot/flow.ts) — a fully specified bet
   *  including stake + leverage, which the review card shows and loads. */
  amount?: number;
  leverage?: number;
}

/** A one-tap onboarding step the chat renders as a button. `connect` is guidance
 *  only (no button — the wallet modal lives in the top bar); the other two run a
 *  real flow in the screen (createAccount / the starter-grant airdrop). */
export type OnboardAction = { kind: 'create_account' | 'get_tokens'; label: string };

/** A shareable snapshot the chat offers to post as an image card (a "Share to X"
 *  affordance under the answer). `fear_greed` carries the reading; `win_rate` is a
 *  bare signal (the screen builds the track-record card payload from its live
 *  history ref), so the two use different modals. The union leaves room for more. */
export type ShareCard =
  | { kind: 'fear_greed'; value: number; label: string }
  | { kind: 'events'; events: { title: string; at: number | null; when: string }[]; headline?: string | null }
  | { kind: 'win_rate' };

export interface CopilotReply {
  text: string[];
  bet?: BetSuggestion;
  /** A strike to light up on the surface WITHOUT suggesting a full bet — the screen
   *  loads it into the store selection. Used by "find me the $X strike". */
  highlight?: { marketId: string; strikePrice: number; isUp: boolean };
  /** An onboarding action card (create account / get test tokens). The screen
   *  renders a button that runs the real flow. */
  action?: OnboardAction;
  /** A snapshot the chat can offer to share as an image card (e.g. fear & greed). */
  share?: ShareCard;
  /** An outbound link rendered as a tappable chip under the message (e.g. the
   *  "message the dev" contact on the fallback reply). Opens in a new tab. */
  link?: { label: string; href: string };
}

/** Target win-chance per conviction — kept inside the quotable band so the
 *  snapped strike is always mintable (never rounds to a 0%/100% dead strike). */
const CONVICTION_TARGET: Record<Conviction, number> = { safe: 0.72, even: 0.5, longshot: 0.28 };

/** Plain-language time-to-settle, e.g. "under a minute" / "about 4 minutes". */
export function timeLeftLabel(expiry: number, now: number): string {
  const ms = expiry - now;
  if (ms <= 0) return 'moments';
  if (ms < 60_000) return 'under a minute';
  const min = Math.round(ms / 60_000);
  if (min === 1) return 'about a minute';
  if (min < 45) return `about ${min} minutes`;
  const hr = Math.round(min / 60);
  return hr === 1 ? 'about an hour' : `about ${hr} hours`;
}

/** A bare duration for "over the next ___" phrasing: "minute", "4 minutes",
 *  "hour", "3 hours". ("about a minute" / "under a minute" don't fit there.) */
function windowLabel(expiry: number, now: number): string {
  const min = Math.max(1, Math.round(Math.max(0, expiry - now) / 60_000));
  if (min < 45) return min === 1 ? 'minute' : `${min} minutes`;
  const hr = Math.round(min / 60);
  return hr === 1 ? 'hour' : `${hr} hours`;
}

/** An adjective for "this ___ market": "1-minute", "4-minute", "1-hour", "3-hour". */
function windowAdj(expiry: number, now: number): string {
  const min = Math.max(1, Math.round(Math.max(0, expiry - now) / 60_000));
  return min < 45 ? `${min}-minute` : `${Math.round(min / 60)}-hour`;
}

/** Pick the market a horizon points at, from those we can price. */
function pickCandidate(candidates: BetCandidate[], horizon: Horizon, now: number): BetCandidate | null {
  const open = candidates.filter((c) => c.market.expiry > now);
  if (open.length === 0) return null;
  if (horizon === 'today') {
    // The longest window we can price — the best available answer for "today" /
    // "in a few hours" on a venue whose listed markets are short.
    return open.reduce((best, c) => (c.market.expiry > best.market.expiry ? c : best));
  }
  if (horizon === 'hour') {
    const target = now + 3_600_000;
    return open.reduce((best, c) =>
      Math.abs(c.market.expiry - target) < Math.abs(best.market.expiry - target) ? c : best,
    );
  }
  return open.reduce((best, c) => (c.market.expiry < best.market.expiry ? c : best));
}

const convictionLead: Record<Conviction, string> = { safe: 'a safer', even: 'an even-odds', longshot: 'a longshot' };

function analyzeReply(ctx: CopilotContext): CopilotReply {
  const read = buildMarketRead({ ctx: ctx.insights, strike: null, isUp: true, strikePrice: null, spot: ctx.insights?.spot ?? null });
  if (!read) {
    return { text: ["I can't reach the live market data right now. Give it a moment and ask again."] };
  }
  const text = [read.headline, ...read.lines.map((l) => l.text)];
  const soonest = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (soonest) text.push(`The soonest market you can bet on settles in ${timeLeftLabel(soonest.market.expiry, ctx.now)}.`);
  // Enrich with the wider-market positioning + institutional flow when we have it
  // (Clawby PRO): the crowd's lean and whether ETFs are adding or trimming.
  const posFunding = ctx.insights?.funding.binancePct ?? ctx.insights?.funding.avgPct ?? null;
  const crowdL = positioningLines(ctx.positioning ?? null, posFunding)[0];
  const etfL = flowLines(ctx.positioning ?? null)[0];
  if (crowdL) text.push(crowdL);
  if (etfL) text.push(etfL);
  // Close with a soft steer (Up / Down / Range) off the same lean — the user
  // asked the analysis to conclude with a recommendation, not just describe.
  const rec = recommendation(ctx.insights);
  if (rec) text.push(...recommendationText(rec, 'close'));
  else text.push("Want me to set one up? Try “safe up bet”, “longshot down bet”, or add “for the next hour”.");
  return { text };
}

function nextMarketReply(ctx: CopilotContext): CopilotReply {
  const cand = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) {
    return { text: ["There's no live market right now. A new one opens about every minute, so check back in a moment."] };
  }
  const { market, pricer } = cand;
  return {
    text: [
      `The next market settles in ${timeLeftLabel(market.expiry, ctx.now)}.`,
      `BTC is around $${num(nowPrice(ctx, pricer), 0)} right now. Bet UP if you think it'll be higher by the close, or DOWN if lower.`,
      'Want me to set one up? Try “safe up bet”, “longshot down bet”, or add “for the next hour”.',
    ],
  };
}

/** Turn an explicit target (70% chance / 3× payout) into a target win-chance,
 *  kept inside the quotable band; falls back to the conviction target. */
function targetProbFor(conviction: Conviction, target?: BetTarget): number {
  const clamp = (v: number) => Math.min(0.95, Math.max(0.05, v));
  if (target?.kind === 'prob') return clamp(target.value);
  if (target?.kind === 'payout') return clamp(1 / target.mult); // payoutMultiple is 1/prob
  return CONVICTION_TARGET[conviction];
}

function betReply(dir: BetDirection, conviction: Conviction, horizon: Horizon, ctx: CopilotContext, target?: BetTarget): CopilotReply {
  const cand = pickCandidate(ctx.candidates, horizon, ctx.now);
  if (!cand) {
    return { text: ["There's no live market to bet on right now. Check back in a moment and I'll set one up."] };
  }
  const { market, pricer } = cand;
  const isUp = dir === 'up';
  const targetP = targetProbFor(conviction, target);
  const strikeScaled = strikeForDirectionFair(targetP, pricer.forward, pricer.svi, market.admission_tick_size, isUp);
  const strikePrice = toFloat(strikeScaled);
  const prob = directionFair(strikePrice, pricer.forward, pricer.svi, isUp);
  const payoutMult = payoutMultiple(prob);
  const label = timeLeftLabel(market.expiry, ctx.now);
  // With an explicit target the conviction label should reflect the ACTUAL odds
  // we landed on, not the (default) wording that came in.
  const conv: Conviction = target ? (prob > 0.6 ? 'safe' : prob < 0.35 ? 'longshot' : 'even') : conviction;

  const text = [
    `Here's ${convictionLead[conv]} ${dir.toUpperCase()} bet on the market settling ${label}.`,
    `It wins if BTC is ${isUp ? 'above' : 'below'} $${num(strikePrice, 0)} at the end. It's around $${num(nowPrice(ctx, pricer), 0)} now.`,
    `The odds work out to about ${pct(prob, 0)}, and it pays about ${payoutMult.toFixed(2)}× your stake if it wins.`,
  ];
  const stance = directionStance(ctx.insights, isUp);
  if (stance === 'aligned') text.push('Good sign: the wider market is leaning the same way right now.');
  else if (stance === 'against') text.push('Worth knowing: the wider market is leaning against this right now.');
  text.push('I’ve marked it on the surface. Tap “Place this bet” to open your ticket and trade it.');

  return {
    text,
    bet: { marketId: market.expiry_market_id, expiry: market.expiry, dir, isUp, strikePrice, prob, payoutMult, conviction: conv, timeLeftLabel: label },
  };
}

/** "What are the odds at $X / of a Y% move?" — quote the chance + payout off the
 *  live surface. A move (or an explicit side) shows one side and loads a bet; a
 *  bare strike shows BOTH sides and lets the trader pick. */
function oddsReply(level: OddsLevel, dir: BetDirection | undefined, ctx: CopilotContext, horizonArg?: Horizon): CopilotReply {
  // "soon"/"now"/no qualifier reads the soonest (~1-minute) market; "today"/"in a
  // few hours" reads the longest market we list, so a strike that's out of reach in
  // a minute gets a real chance over the longer window.
  const horizon = horizonArg ?? 'soonest';
  const cand = pickCandidate(ctx.candidates, horizon, ctx.now);
  if (!cand) {
    return { text: ["There's no live market to price right now. Check back in a moment and ask again."] };
  }
  const { market, pricer } = cand;
  const label = timeLeftLabel(market.expiry, ctx.now);
  const spotNow = ctx.spot ?? pricer.forward;
  // If the trader asked about a longer window than we actually list, say which
  // window we're really pricing, so "today" doesn't silently become a short answer.
  const minsLeft = (market.expiry - ctx.now) / 60_000;
  const windowNote =
    horizon === 'today' && minsLeft < 45
      ? `The longest market I can price right now settles in ${label}, so that's the window here. `
      : horizon === 'hour' && minsLeft < 30
        ? `The market nearest an hour out settles in ${label}, so that's what I'm using. `
        : '';

  // Resolve the level to an absolute, admission-snapped strike.
  let rawStrike: number;
  let moveNote = '';
  if (level.kind === 'strike') {
    rawStrike = level.price;
  } else {
    const frac = level.pct / 100;
    const side = dir ?? 'up';
    rawStrike = spotNow * (1 + (side === 'up' ? frac : -frac));
    moveNote = ` (a ${num(level.pct, 1)}% move ${side}, to ~$${num(rawStrike, 0)})`;
  }
  const strike = toFloat(snapStrikeToAdmission(fromFloat(rawStrike), market.admission_tick_size));
  const up = upFair(strike, pricer.forward, pricer.svi);
  if (up <= 0.005 || up >= 0.995) {
    return {
      text: [
        `${windowNote}$${num(strike, 0)} is so far from the current $${num(spotNow, 0)} that it's almost ${up >= 0.5 ? 'certain' : 'impossible'} even on this ${windowAdj(market.expiry, ctx.now)} market. Too lopsided to price. Try a level closer to $${num(spotNow, 0)}.`,
      ],
    };
  }

  // A % move (or an explicit side) → one side, the FULL read (surface odds + the
  // empirical base rate + the Clawby market context → a verdict) + a loadable bet.
  if (level.kind === 'move' || dir) {
    const isUp = (dir ?? 'up') === 'up';
    const prob = isUp ? up : 1 - up;
    const payoutMult = payoutMultiple(prob);
    const text: string[] = [
      `${windowNote}The chance BTC settles ${isUp ? 'above' : 'at or below'} $${num(strike, 0)}${moveNote} in ${label} is about ${pct(prob, 0)}. A winning bet pays about ${payoutMult.toFixed(2)}× your stake.`,
    ];

    // Past history: how often BTC has ACTUALLY landed there, plus a plain verdict.
    const minutesToExpiry = Math.max(1, Math.round((market.expiry - ctx.now) / 60_000));
    if (ctx.closes && ctx.closes.length >= 30) {
      const a = analyzeStrike({ closes: ctx.closes, spot: spotNow, strike, isUp, minutesToExpiry, impliedProb: prob });
      if (a?.empirical) {
        text.push(`Looking back, it's actually landed there about ${pct(a.empirical.prob, 0)} of the time across ${a.empirical.samples.toLocaleString()} past ${minutesToExpiry}-minute windows.`);
        text.push(strikeVerdict(a).text);
      }
    }

    // Clawby market context leaning for/against this side.
    const stance = directionStance(ctx.insights, isUp);
    if (stance === 'aligned') text.push('The wider market (funding, sentiment, recent liquidations) is leaning the same way, a small tailwind.');
    else if (stance === 'against') text.push('Worth knowing: the wider market (funding, sentiment, recent liquidations) is leaning against this side right now.');

    text.push('Not financial advice. I’ve marked it on the surface. Tap “Place this bet” to load it.');
    return {
      text,
      bet: {
        marketId: market.expiry_market_id,
        expiry: market.expiry,
        dir: isUp ? 'up' : 'down',
        isUp,
        strikePrice: strike,
        prob,
        payoutMult,
        conviction: prob > 0.6 ? 'safe' : prob < 0.35 ? 'longshot' : 'even',
        timeLeftLabel: label,
      },
    };
  }

  // Bare strike, no side → show both sides and let them pick.
  return {
    text: [
      `${windowNote}At $${num(strike, 0)}, settling in ${label}:`,
      `Above: about ${pct(up, 0)} chance, pays ~${payoutMultiple(up).toFixed(2)}×.`,
      `At or below: about ${pct(1 - up, 0)} chance, pays ~${payoutMultiple(1 - up).toFixed(2)}×.`,
      `Want one? Say “up bet” or “down bet”, or “set up a trade” to fix that exact strike.`,
    ],
  };
}

/* --------------------- surface-native analysis (Z / Y / shape) ----------- */

const NO_MARKET: CopilotReply = { text: ["There's no live market to read right now. Check back in a moment and ask again."] };

/** "How often has BTC actually moved that much?" — the surface's implied chance
 *  vs the empirical base rate from the recent price tape (the credibility flex).
 *  Reuses analyzeStrike + strikeVerdict (a plain, jargon-free read). */
function realityCheckReply(level: OddsLevel | undefined, dir: BetDirection | undefined, ctx: CopilotContext): CopilotReply {
  const cand = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const closes = ctx.closes;
  if (!closes || closes.length < 30) {
    return { text: ["I don't have enough price history loaded yet to check that. Give it a moment and ask again."] };
  }
  const { market, pricer } = cand;
  const label = timeLeftLabel(market.expiry, ctx.now);
  const minutesToExpiry = Math.max(1, Math.round((market.expiry - ctx.now) / 60_000));
  const spotNow = ctx.spot ?? pricer.forward;
  const isUp = dir !== 'down';
  // Resolve a strike (default: a modest 0.5% move in the asked direction).
  const rawStrike =
    level?.kind === 'strike'
      ? level.price
      : spotNow * (1 + ((level?.kind === 'move' ? level.pct : 0.5) / 100) * (isUp ? 1 : -1));
  const strike = toFloat(snapStrikeToAdmission(fromFloat(rawStrike), market.admission_tick_size));
  const implied = directionFair(strike, pricer.forward, pricer.svi, isUp);
  const a = analyzeStrike({ closes, spot: spotNow, strike, isUp, minutesToExpiry, impliedProb: implied });
  if (!a || !a.empirical) {
    return { text: [`I couldn't find enough past ${minutesToExpiry}-minute windows to judge a move to $${num(strike, 0)}. Try a smaller move or a nearer strike.`] };
  }
  const verdict = strikeVerdict(a); // plain-language, no jargon
  return {
    text: [
      `Settling ${isUp ? 'above' : 'at or below'} $${num(strike, 0)} (a ${signed(a.requiredMovePct, 2)}% move from ~$${num(spotNow, 0)}) in ${label}: the surface prices it at about ${pct(implied, 0)}.`,
      `Looking back, BTC has actually landed there about ${pct(a.empirical.prob, 0)} of the time across ${a.empirical.samples.toLocaleString()} past ${minutesToExpiry}-minute windows.`,
      verdict.text,
      'Not financial advice. History is a guide, not a guarantee. Want it? Say “up bet” / “down bet”, or “set up a trade”.',
    ],
  };
}

/** "Analyse the current / this strike" — a focused read of the strike the ticket
 *  is on: the surface's odds + payout, the recent reality check, and the Clawby
 *  market context for that side. Falls back to the at-the-money strike on the
 *  soonest market when nothing's selected yet. */
function analyzeStrikeReply(ctx: CopilotContext, price?: number, dir?: BetDirection): CopilotReply {
  const sel = ctx.selection;
  const cand =
    (sel && ctx.candidates.find((c) => c.market.expiry_market_id === sel.marketId)) ??
    pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const { market, pricer } = cand;
  const label = timeLeftLabel(market.expiry, ctx.now);
  const spotNow = ctx.spot ?? pricer.forward;

  // The strike being looked at: a strike the trader NAMED wins, else the selected
  // one, else at-the-money.
  const rawStrike = price != null && price > 0 ? price : sel && sel.strikePrice > 0 ? sel.strikePrice : spotNow;
  const strike = toFloat(snapStrikeToAdmission(fromFloat(rawStrike), market.admission_tick_size));
  // Direction: an explicit up/down wins; else the current selection's side (when
  // reading "this" strike); else default to the more-likely side of a named strike.
  const isUp = dir != null ? dir === 'up' : price == null && sel ? sel.isUp : strike <= spotNow;
  // When the trader named a specific strike, light it up on the surface too.
  const highlight = price != null && price > 0 ? { marketId: market.expiry_market_id, strikePrice: strike, isUp } : undefined;

  const up = upFair(strike, pricer.forward, pricer.svi);
  if (up <= 0.005 || up >= 0.995) {
    const text = [
      `$${num(strike, 0)} is so far from the current $${num(spotNow, 0)} that it's almost ${up >= 0.5 ? 'certain' : 'impossible'} on this ${windowAdj(market.expiry, ctx.now)} market. Too lopsided to read. Pick a strike nearer $${num(spotNow, 0)}.`,
    ];
    return highlight ? { text, highlight } : { text };
  }
  const prob = isUp ? up : 1 - up;
  const payoutMult = payoutMultiple(prob);
  const movePct = spotNow > 0 ? ((strike - spotNow) / spotNow) * 100 : 0;

  const text: string[] = [
    `Looking at ${isUp ? 'UP' : 'DOWN'} $${num(strike, 0)} on the market settling in ${label}, BTC is around $${num(spotNow, 0)} now (${signed(movePct, 2)}% away).`,
    `The surface prices it at about ${pct(prob, 0)} to win, paying ~${payoutMult.toFixed(2)}× your stake.`,
  ];

  // The empirical reality check from the recent tape, when we have enough history.
  const minutesToExpiry = Math.max(1, Math.round((market.expiry - ctx.now) / 60_000));
  if (ctx.closes && ctx.closes.length >= 30) {
    const a = analyzeStrike({ closes: ctx.closes, spot: spotNow, strike, isUp, minutesToExpiry, impliedProb: prob });
    if (a?.empirical) {
      text.push(
        `Looking back, BTC has actually landed there about ${pct(a.empirical.prob, 0)} of the time across ${a.empirical.samples.toLocaleString()} past ${minutesToExpiry}-minute windows.`,
      );
      text.push(strikeVerdict(a).text);
    }
  }

  // Clawby market context for this side.
  const stance = directionStance(ctx.insights, isUp);
  if (stance === 'aligned') text.push('The wider market (funding, sentiment, recent liquidations) is leaning the same way, a small tailwind for this side.');
  else if (stance === 'against') text.push('Worth knowing: the wider market (funding, sentiment, recent liquidations) is leaning against this side right now.');
  else if (ctx.insights?.available) text.push("The wider market isn't leaning strongly either way right now.");

  text.push('Not financial advice. Just how the surface and the data read. Want it? Say “set up a trade”, or place it from the ticket.');
  return highlight ? { text, highlight } : { text };
}

/** "Find / show me the $X strike on the surface" — snap it to a real tradeable
 *  strike, hand back a `highlight` the screen lights up, and quote both sides so
 *  the trader can act. A strike far outside the quotable band is still highlighted,
 *  with a heads-up that it's too lopsided to trade here. */
function findStrikeReply(price: number, dir: BetDirection | undefined, ctx: CopilotContext): CopilotReply {
  const cand =
    (ctx.selection && ctx.candidates.find((c) => c.market.expiry_market_id === ctx.selection!.marketId)) ??
    pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const { market, pricer } = cand;
  const label = timeLeftLabel(market.expiry, ctx.now);
  const spotNow = ctx.spot ?? pricer.forward;
  const strike = toFloat(snapStrikeToAdmission(fromFloat(price), market.admission_tick_size));
  const up = upFair(strike, pricer.forward, pricer.svi);
  const movePct = spotNow > 0 ? ((strike - spotNow) / spotNow) * 100 : 0;
  const isUp = dir ?? (strike > spotNow ? 'down' : 'up'); // default to the more-likely side
  const snapNote = Math.abs(strike - price) >= 1 ? ` (nearest tradeable strike to $${num(price, 0)})` : '';
  const highlight = { marketId: market.expiry_market_id, strikePrice: strike, isUp: isUp === 'up' };

  if (up <= 0.005 || up >= 0.995) {
    return {
      text: [
        `Here's $${num(strike, 0)}${snapNote}, I've highlighted it on the surface. It's ${signed(movePct, 2)}% from the current $${num(spotNow, 0)}, so far out it's almost ${up >= 0.5 ? 'certain' : 'a long shot'} on this ${label} market.`,
        'Pick a strike nearer the current price for a tradeable bet, or say “analyze this strike”.',
      ],
      highlight,
    };
  }
  return {
    text: [
      `Found it, $${num(strike, 0)}${snapNote}, ${signed(movePct, 2)}% from the current $${num(spotNow, 0)}. I've highlighted it on the surface for the market settling ${label}.`,
      `Above: about ${pct(up, 0)} chance, pays ~${payoutMultiple(up).toFixed(2)}×. At or below: about ${pct(1 - up, 0)} chance, pays ~${payoutMultiple(1 - up).toFixed(2)}×.`,
      'Say “up bet” or “down bet” to trade it, or “analyze this strike” for the full read.',
    ],
    highlight,
  };
}

/** A conversational tweak to the current bet — "make it $10", "use 3x", "flip to
 *  down", "change the strike to 65,500". Merges the change onto the current ticket
 *  selection, re-quotes, and returns an updated bet the screen loads (so "trade it"
 *  works on the new numbers). Guides the trader to set one up first if there's none. */
function adjustReply(adj: { stake?: number; leverage?: number; strike?: number; dir?: BetDirection; flip?: boolean }, ctx: CopilotContext): CopilotReply {
  const sel = ctx.selection;
  const cand =
    (sel && ctx.candidates.find((c) => c.market.expiry_market_id === sel.marketId)) ??
    pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const { market, pricer } = cand;
  const spotNow = ctx.spot ?? pricer.forward;

  const haveStrike = adj.strike != null || (sel?.strikePrice != null && sel.strikePrice > 0);
  if (!haveStrike) {
    return { text: ['Set up a bet first and I’ll tweak it from there. Say “safe up bet” or “set up a trade”, then tell me to change the amount, leverage, strike, or side.'] };
  }
  const isUp = adj.flip ? !(sel?.isUp ?? true) : adj.dir ? adj.dir === 'up' : (sel?.isUp ?? true);
  const strike = toFloat(snapStrikeToAdmission(fromFloat(adj.strike ?? sel!.strikePrice), market.admission_tick_size));
  const entryProb = directionFair(strike, pricer.forward, pricer.svi, isUp);
  if (entryProb <= 0.005 || entryProb >= 0.995) {
    return { text: [`$${num(strike, 0)} is too far from the current $${num(spotNow, 0)} to trade on this market. Pick a strike nearer the price.`] };
  }
  const stake = adj.stake ?? sel?.stake ?? 5;
  const maxLev = leverageSliderMax(entryProb, toFloat(market.max_admission_leverage));
  const leverage = Math.min(Math.max(1, adj.leverage ?? sel?.leverage ?? 1), maxLev);
  const win = fromQuote(winPayout(quantityForStake(toQuote(stake), entryProb, leverage), entryProb, leverage));
  const payoutMult = stake > 0 ? win / stake : 1;
  const label = timeLeftLabel(market.expiry, ctx.now);

  const changed: string[] = [];
  if (adj.strike != null) changed.push(`strike $${num(strike, 0)}`);
  if (adj.flip || adj.dir != null) changed.push(isUp ? 'UP' : 'DOWN');
  if (adj.stake != null) changed.push(`$${num(stake, 0)} stake`);
  if (adj.leverage != null) changed.push(`${num(leverage, 1)}× leverage`);
  const capNote = adj.leverage != null && adj.leverage > maxLev ? ` (capped at ${num(maxLev, 1)}× for this strike)` : '';

  return {
    text: [
      `Updated, ${changed.join(', ') || 'your bet'}${capNote}.`,
      `${isUp ? 'UP' : 'DOWN'} $${num(strike, 0)}, $${num(stake, 0)} at ${num(leverage, 1)}×. About ${pct(entryProb, 0)} to win, could win ~$${num(win, 0)}.`,
      'Say “trade it” to place it, or tell me another change.',
    ],
    bet: {
      marketId: market.expiry_market_id,
      expiry: market.expiry,
      dir: isUp ? 'up' : 'down',
      isUp,
      strikePrice: strike,
      prob: entryProb,
      payoutMult,
      conviction: entryProb > 0.6 ? 'safe' : entryProb < 0.35 ? 'longshot' : 'even',
      timeLeftLabel: label,
      amount: stake,
      leverage,
    },
  };
}

/** "What's the best value right now?" — scan the strikes around spot on the live
 *  market and find where the surface's price most underrates how often BTC has
 *  actually landed there (empirical > implied = good value for the buyer). Reuses
 *  the reality-check machinery; highlights the winner. Needs the candle tape. */
function bestValueReply(ctx: CopilotContext): CopilotReply {
  const cand =
    (ctx.selection && ctx.candidates.find((c) => c.market.expiry_market_id === ctx.selection!.marketId)) ??
    pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const { market, pricer } = cand;
  const closes = ctx.closes;
  if (!closes || closes.length < 30) {
    return { text: ["I need a bit more price history to judge value. Give it a moment and ask again."] };
  }
  const spotNow = ctx.spot ?? pricer.forward;
  const minutesToExpiry = Math.max(1, Math.round((market.expiry - ctx.now) / 60_000));

  // Scan a band of strikes both sides of spot; keep the reasonably tradeable ones
  // (implied 10-90%), dedup after snapping, and rank by empirical − implied.
  type ValueCand = { strike: number; isUp: boolean; implied: number; empirical: number; samples: number; value: number };
  const seen = new Set<string>();
  const cands: ValueCand[] = [];
  for (let p = -2.5; p <= 2.5 + 1e-9; p += 0.25) {
    if (Math.abs(p) < 0.1) continue;
    const strike = toFloat(snapStrikeToAdmission(fromFloat(spotNow * (1 + p / 100)), market.admission_tick_size));
    for (const isUp of [true, false] as const) {
      const key = `${strike}:${isUp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const implied = directionFair(strike, pricer.forward, pricer.svi, isUp);
      if (implied <= 0.1 || implied >= 0.9) continue;
      const a = analyzeStrike({ closes, spot: spotNow, strike, isUp, minutesToExpiry, impliedProb: implied });
      if (!a?.empirical || a.empirical.samples < 20) continue;
      cands.push({ strike, isUp, implied, empirical: a.empirical.prob, samples: a.empirical.samples, value: a.empirical.prob - implied });
    }
  }
  cands.sort((a, b) => b.value - a.value);
  const best = cands[0];
  if (!best || best.value <= 0.03) {
    // No mispriced edge — the market's fair. Don't dead-end: recommend the
    // cleanest straightforward bet instead. Side it by the off-chain lean when
    // there is one, else by the surface's own slight tilt (chance of a pop vs a
    // drop), and load a SAFE bet into the ticket so "best bet" is always actionable.
    const rec = recommendation(ctx.insights);
    const isUpPick =
      rec?.pick === 'up' ? true
      : rec?.pick === 'down' ? false
      : upFair(pricer.forward * 1.01, pricer.forward, pricer.svi) >= 1 - upFair(pricer.forward * 0.99, pricer.forward, pricer.svi);
    const dir: BetDirection = isUpPick ? 'up' : 'down';
    const strikePrice = toFloat(strikeForDirectionFair(CONVICTION_TARGET.safe, pricer.forward, pricer.svi, market.admission_tick_size, isUpPick));
    const prob = directionFair(strikePrice, pricer.forward, pricer.svi, isUpPick);
    const payoutMult = payoutMultiple(prob);
    const label = timeLeftLabel(market.expiry, ctx.now);
    return {
      text: [
        "Nothing's clearly mispriced right now. The surface is pricing moves about as often as they've actually happened, so it's a fair, efficient market.",
        `So here's the most solid value bet I'd pick: a safer ${dir.toUpperCase()} on the ${windowAdj(market.expiry, ctx.now)} market. It wins if BTC is ${isUpPick ? 'above' : 'below'} $${num(strikePrice, 0)} at the close, about ${pct(prob, 0)} to win, and pays ~${payoutMult.toFixed(2)}×.`,
        'Not financial advice. I’ve loaded it into your ticket. Tap “Place this bet” to trade it, or say “longshot bet” if you want a bigger payout.',
      ],
      bet: { marketId: market.expiry_market_id, expiry: market.expiry, dir, isUp: isUpPick, strikePrice, prob, payoutMult, conviction: 'safe', timeLeftLabel: label },
    };
  }
  const conv: Conviction = best.implied > 0.6 ? 'safe' : best.implied < 0.35 ? 'longshot' : 'even';
  return {
    text: [
      `Best value I can find on the ${windowAdj(market.expiry, ctx.now)} market: ${best.isUp ? 'UP' : 'DOWN'} $${num(best.strike, 0)}.`,
      `The surface gives it about ${pct(best.implied, 0)} to win (pays ~${payoutMultiple(best.implied).toFixed(2)}×), but across the last ${best.samples.toLocaleString()} similar ${minutesToExpiry}-minute windows BTC actually landed there about ${pct(best.empirical, 0)} of the time. Better odds than the price is asking for.`,
      'Not financial advice, and past moves are only a guide. I’ve loaded it into your ticket. Tap “Place this bet” to trade it, or ask me to “analyze this strike”.',
    ],
    bet: { marketId: market.expiry_market_id, expiry: market.expiry, dir: best.isUp ? 'up' : 'down', isUp: best.isUp, strikePrice: best.strike, prob: best.implied, payoutMult: payoutMultiple(best.implied), conviction: conv, timeLeftLabel: timeLeftLabel(market.expiry, ctx.now) },
  };
}

/** "How big a move is priced in?" — the ATM ±1σ band over the tenor (kept in
 *  concrete $/% terms; we don't annualize, which is meaningless on a 1-min tenor). */
/** BTC's recent realized 1σ move over an N-minute tenor, from the 1-minute close
 *  tape — the yardstick we judge the surface's implied swing against ("is vol
 *  high?"). Returns a fraction of spot, or null when there isn't enough history. */
function realizedTenorSigma(closes: number[] | null | undefined, minutes: number): number | null {
  if (!closes || closes.length < 30) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(Math.max(0, variance)) * Math.sqrt(Math.max(1, minutes));
}

function volatilityReply(ctx: CopilotContext): CopilotReply {
  const cand = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const { market, pricer } = cand;
  const sigma = Math.sqrt(Math.max(0, totalVariance(pricer.forward, pricer.forward, pricer.svi))); // 1σ move to expiry (fraction)
  const spotNow = ctx.spot ?? pricer.forward;
  const moveUsd = spotNow * sigma;
  const text: string[] = [
    `Over the next ${windowLabel(market.expiry, ctx.now)}, the surface expects BTC to move about $${num(moveUsd, 0)} up or down (roughly ${pct(sigma, 2)}) by the close.`,
    `That gives it about a 2 in 3 chance of finishing between $${num(spotNow - moveUsd, 0)} and $${num(spotNow + moveUsd, 0)}. A move bigger than about $${num(moveUsd * 2, 0)} either way would be unusual.`,
  ];

  // Is that high or calm? Judge the implied swing against BTC's recent realized move.
  const minutes = Math.max(1, Math.round((market.expiry - ctx.now) / 60_000));
  const realized = realizedTenorSigma(ctx.closes, minutes);
  if (realized && realized > 0) {
    const realizedUsd = spotNow * realized;
    const ratio = sigma / realized;
    text.push(
      ratio > 1.15
        ? `Right now that is on the high side. The surface expects a bigger move than BTC has actually been making lately, which is about $${num(realizedUsd, 0)} up or down. So expect bigger swings, and bets on a large move pay more.`
        : ratio < 0.87
          ? `Right now that is on the calm side. It is smaller than BTC has been moving lately, which is about $${num(realizedUsd, 0)} up or down. So moves look quiet, and the safer bets cost less.`
          : `That is about the same as BTC has actually been moving lately, around $${num(realizedUsd, 0)} up or down.`,
    );
  }

  text.push('Tell me a direction and I’ll set up a bet for you, or say “set up a trade”.');
  return { text };
}

/** "Crash or pump?" — compare the priced chance of a 1% drop vs a 1% pop. */
function skewReply(ctx: CopilotContext): CopilotReply {
  const cand = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) return NO_MARKET;
  const { market, pricer } = cand;
  const f = pricer.forward;
  const d = 0.01; // ±1%
  const pUp = upFair(f * (1 + d), f, pricer.svi); // chance of a ≥1% pop
  const pDown = 1 - upFair(f * (1 - d), f, pricer.svi); // chance of a ≥1% drop
  const ratio = pDown / Math.max(1e-6, pUp);
  const lean =
    ratio > 1.15 ? 'leaning to the DOWNSIDE. A sharp drop is priced as more likely than an equal-sized pop'
    : ratio < 0.87 ? 'leaning to the UPSIDE. A sharp pop is priced as more likely than an equal-sized drop'
    : "roughly balanced. It isn't favoring a crash or a pump";
  return {
    text: [
      `Over the next ${windowLabel(market.expiry, ctx.now)}, the surface prices about a ${pct(pDown, 0)} chance of a 1% drop versus ${pct(pUp, 0)} for a 1% pop.`,
      `So it's ${lean}.`,
      'Not financial advice. Just the shape of the odds. Tell me a direction and I’ll set up a bet.',
    ],
  };
}

/** "1-minute or 5-minute? / wait for the hour?" — the chance of a small move
 *  across each open expiry, so the trader sees how time changes the odds. */
function termStructureReply(dir: BetDirection | undefined, ctx: CopilotContext): CopilotReply {
  const open = ctx.candidates.filter((c) => c.market.expiry > ctx.now).sort((a, b) => a.market.expiry - b.market.expiry);
  if (open.length === 0) return NO_MARKET;
  const isUp = dir !== 'down';
  const d = 0.005; // a small 0.5% move
  const spotNow = ctx.spot ?? open[0].pricer.forward;
  const rows = open.slice(0, 3).map((c) => {
    const f = c.pricer.forward;
    const prob = directionFair(f * (1 + (isUp ? d : -d)), f, c.pricer.svi, isUp);
    return `${timeLeftLabel(c.market.expiry, ctx.now)}: about ${pct(prob, 0)}`;
  });
  return {
    text: [
      `Chance of a small (0.5%) ${isUp ? 'up' : 'down'} move from ~$${num(spotNow, 0)}, by each market's close:`,
      ...rows,
      'Longer markets give a move more time to happen. But as the odds rise, the payout shrinks. Say “set up a trade” to pick one.',
    ],
  };
}

/** "Any mispricings? / is the surface arb-free?" — run the butterfly + calendar
 *  checker across the live surface (the credibility flex). */
function noArbReply(ctx: CopilotContext): CopilotReply {
  const inputs = ctx.surfaceInputs;
  if (!inputs || inputs.length < 2) {
    return { text: ['I need a couple of live expiries to check the surface for mispricings. Check back in a moment.'] };
  }
  const surface = buildSurface(inputs, { nowMs: ctx.now });
  let butterfly = 0;
  let calendar = 0;
  for (const row of surface.rows) {
    for (const cell of row.cells) {
      if (cell.butterfly) butterfly++;
      if (cell.calendar) calendar++;
    }
  }
  if (butterfly + calendar === 0) {
    return {
      text: [
        'The surface is clean. No arbitrage violations right now.',
        "Every strike's odds fall smoothly as the price target rises, and they line up across expiries, so nothing is mispriced. That's how it should look on live data.",
      ],
    };
  }
  const parts = [butterfly ? `${butterfly} butterfly` : '', calendar ? `${calendar} calendar` : ''].filter(Boolean).join(' and ');
  return {
    text: [
      `Heads up, I spotted ${parts} spot${butterfly + calendar > 1 ? 's' : ''} where the odds don't line up cleanly.`,
      "That's almost always a fleeting data blip (a stale feed), not a real free lunch, I'd steer clear of those exact strikes until it settles.",
    ],
  };
}

/**
 * "Why does the surface look like this?" — a plain-language read of the surface's
 * CURRENT shape, so a trader who doesn't know how to read it understands what
 * they're seeing. Three parts, each a real thing on the picture:
 *   • Height — how big a move is priced in (calm vs busy) on the nearest market.
 *   • Tilt   — which side sits higher (a drop vs a pop priced richer), the "lean".
 *   • Slope  — how the expected move changes from the nearest to the furthest
 *              market (why it rises or dips going back in time).
 * All from the SAME functions the vol / skew / term reads use, so it can never
 * contradict them. No jargon (no "vol"/"skew"/"tilt-word soup"): plain shapes.
 */
function surfaceShapeReply(ctx: CopilotContext): CopilotReply {
  const open = ctx.candidates.filter((c) => c.market.expiry > ctx.now).sort((a, b) => a.market.expiry - b.market.expiry);
  if (open.length === 0) return NO_MARKET;
  const near = open[0];
  const far = open[open.length - 1];
  const f = near.pricer.forward;
  const spotNow = ctx.spot ?? f;

  const text: string[] = [
    'Here’s why the surface looks the way it does right now. Left to right is the price BTC could finish at, front to back is how far out the market closes, and the height and color show how big a move is priced in.',
  ];

  // Height — the size of the priced move on the nearest market, judged against
  // what BTC has actually been doing lately (the same verdict as the vol read).
  const sigmaNear = Math.sqrt(Math.max(0, totalVariance(f, f, near.pricer.svi)));
  const moveUsd = spotNow * sigmaNear;
  const minutes = Math.max(1, Math.round((near.market.expiry - ctx.now) / 60_000));
  const realized = realizedTenorSigma(ctx.closes, minutes);
  let height = `Height: over the next ${windowLabel(near.market.expiry, ctx.now)} it prices about a $${num(moveUsd, 0)} move up or down. `;
  if (realized && realized > 0) {
    const ratio = sigmaNear / realized;
    height +=
      ratio > 1.15
        ? 'That’s bigger than BTC has actually been moving lately, so the surface sits tall and bright, and bets on a large move pay more.'
        : ratio < 0.87
          ? 'That’s smaller than BTC has actually been moving lately, so the surface sits low and calm, and the safer bets cost less.'
          : 'That’s about what BTC has actually been moving lately, so the surface sits at a normal height.';
  } else {
    height += 'The taller and brighter it is, the bigger the move being priced in.';
  }
  text.push(height);

  // Tilt — a 1% drop vs a 1% pop, the plain-words version of the lean. Same math
  // as the skew read, so the two never disagree.
  const d = 0.01;
  const pUp = upFair(f * (1 + d), f, near.pricer.svi);
  const pDown = 1 - upFair(f * (1 - d), f, near.pricer.svi);
  const ratioTilt = pDown / Math.max(1e-6, pUp);
  text.push(
    ratioTilt > 1.15
      ? `Tilt: it leans to the downside. A 1% drop is priced at about ${pct(pDown, 0)} versus ${pct(pUp, 0)} for a 1% pop, so the left side sits a little higher. That usually means the market is paying up for protection against a fall.`
      : ratioTilt < 0.87
        ? `Tilt: it leans to the upside. A 1% pop is priced at about ${pct(pUp, 0)} versus ${pct(pDown, 0)} for a 1% drop, so the right side sits a little higher. That usually means more appetite for an upside move.`
        : `Tilt: it’s fairly even. A 1% drop and a 1% pop price about the same (${pct(pDown, 0)} versus ${pct(pUp, 0)}), so neither side sits much higher than the other.`,
  );

  // Slope — how the priced move changes from the nearest to the furthest market
  // (why the surface climbs or dips going back). Only when there's a second expiry.
  if (far.market.expiry > near.market.expiry) {
    const ff = far.pricer.forward;
    const sigmaFar = Math.sqrt(Math.max(0, totalVariance(ff, ff, far.pricer.svi)));
    const moveFarUsd = (ctx.spot ?? ff) * sigmaFar;
    text.push(
      moveFarUsd > moveUsd * 1.1
        ? `Slope: it rises toward the back. The furthest market (${timeLeftLabel(far.market.expiry, ctx.now)}) prices a bigger move, about $${num(moveFarUsd, 0)}, because more time gives price more room to run.`
        : moveFarUsd < moveUsd * 0.9
          ? `Slope: it dips toward the back. The furthest market (${timeLeftLabel(far.market.expiry, ctx.now)}) prices a smaller move, about $${num(moveFarUsd, 0)}, right now.`
          : 'Slope: it’s fairly flat front to back. The nearest and furthest markets price a similar-sized move right now.',
    );
  }

  // Jaggedness — a spot where the odds don't line up (a brief data blip). The same
  // checker the no-arb read runs; only mentioned when it actually fires.
  if (ctx.surfaceInputs && ctx.surfaceInputs.length >= 2) {
    const surface = buildSurface(ctx.surfaceInputs, { nowMs: ctx.now });
    if (surface.hasButterfly || surface.hasCalendar) {
      text.push(
        'One part also looks a little jagged right now. That’s almost always a brief data blip, not a real opening, so I’d avoid those exact price targets until it settles.',
      );
    }
  }

  text.push('Want to act on it? Tell me a direction and I’ll set up a bet, or say “set up a trade”.');
  return { text };
}

/* ------------------------- soft recommendation --------------------------- */
// A steer, not advice: which way the blended market lean points (Up / Down /
// Range). Same data + threshold as the read's "leaning …" headline, so they
// never contradict. We always say it's not financial advice.

type Rec = NonNullable<ReturnType<typeof recommendation>>;

const pickPhrase = (pick: Rec['pick']) => (pick === 'up' ? 'an UP bet' : pick === 'down' ? 'a DOWN bet' : 'a RANGE bet');

/** How to place the recommended shape — Up/Down are one-liners the co-pilot can
 *  set up; Range is built on the surface/ticket (chat range setup isn't wired). */
function recSetupHint(rec: Rec): string {
  if (rec.pick === 'range') {
    return 'To play a range, tap two price levels on the surface, or open the ticket and switch to Range.';
  }
  return `Want me to set it up? Say ${rec.pick === 'up' ? '“safe up bet”' : '“safe down bet”'}, or “set up a trade” to pick the details.`;
}

/**
 * The recommendation sentence(s). `mode`:
 *  - 'lead'  → recommendation FIRST (for a "should I?" question), the read follows.
 *  - 'close' → a one-line steer to CLOSE an analysis read.
 */
function recommendationText(rec: Rec, mode: 'lead' | 'close'): string[] {
  if (rec.pick === 'range') {
    const core =
      mode === 'lead'
        ? "There's no clear direction right now, so rather than pick a side I'd lean to a RANGE bet. You win if BTC stays between two prices you choose."
        : "Bottom line: no clear direction right now, so a RANGE bet (BTC stays between two prices) may fit better than picking a side.";
    return [`${core} That's not financial advice, just how the live data reads.`, recSetupHint(rec)];
  }
  const strength = rec.confidence === 'clear' ? "I'd lean toward" : 'it slightly favors';
  const core =
    mode === 'lead'
      ? `Leaning on the live data, ${strength} ${pickPhrase(rec.pick)}.`
      : `Bottom line: ${strength} ${pickPhrase(rec.pick)}.`;
  return [`${core} That's not financial advice, just how the data reads.`, recSetupHint(rec)];
}

/** "Should I go up or down (or range)?" — lead with the steer, then the read that
 *  backs it, so the trader sees the answer first and the why underneath. */
function recommendReply(ctx: CopilotContext): CopilotReply {
  const rec = recommendation(ctx.insights);
  const read = buildMarketRead({ ctx: ctx.insights, strike: null, isUp: true, strikePrice: null, spot: ctx.insights?.spot ?? null });
  if (!rec || !read) {
    return { text: ["I can't reach the live market data right now, so I can't give you a steer. Give it a moment and ask again."] };
  }
  const [steer, hint] = recommendationText(rec, 'lead');
  return {
    text: [
      steer,
      read.headline,
      ...read.lines.map((l) => l.text),
      hint,
    ],
  };
}

/* ----------------------- focused single-metric answers ------------------- */
// A direct question about one number ("what's the fear & greed?") gets a short,
// purpose-built answer — NOT the whole market read — then a light nudge toward the
// full read or a bet. Each reads the SAME live insights the full read uses.

const METRIC_CTA = 'Say “analyze BTC” for the full picture, or tell me a direction and I’ll set up a bet.';

function fearGreedReply(ins: BtcInsights): CopilotReply {
  const s = ins.sentiment;
  if (!s) return { text: ["I don't have a fear & greed reading right now. Give it a moment and ask again."] };
  const mood =
    s.value <= 25 ? 'people are very fearful. The crowd is nervous and often over-selling'
    : s.value < 45 ? 'people are leaning fearful. A cautious mood'
    : s.value <= 55 ? 'the mood is roughly balanced between fear and greed'
    : s.value < 75 ? 'people are leaning greedy. A confident, risk-on mood'
    : 'people are very greedy. The crowd is euphoric and often over-buying';
  return {
    text: [
      `BTC's Fear & Greed Index is ${s.value}/100 right now. That's ${s.label}.`,
      `In plain terms, ${mood}.`,
      METRIC_CTA,
    ],
    share: { kind: 'fear_greed', value: s.value, label: s.label },
  };
}

function fundingReply(ins: BtcInsights): CopilotReply {
  const f = ins.funding.avgPct ?? ins.funding.binancePct;
  if (f == null) return { text: ["I don't have a funding-rate reading right now. Give it a moment and ask again."] };
  const sign = f > 0.0001 ? 'positive' : f < -0.0001 ? 'negative' : 'about flat';
  const mean =
    f > 0.0001 ? 'Traders betting it goes UP are paying to hold, so the crowd is leaning long.'
    : f < -0.0001 ? 'Traders betting it goes DOWN are paying to hold, so the crowd is leaning short.'
    : 'Neither side is really paying to hold, so the crowd is balanced.';
  return { text: [`BTC funding is ${signed(f, 3)}% right now. That's ${sign}.`, mean, METRIC_CTA] };
}

function liquidationsReply(ins: BtcInsights): CopilotReply {
  const { longUsd, shortUsd, totalUsd } = ins.liq24h;
  if (longUsd == null || shortUsd == null) {
    return { text: ["I don't have liquidation figures right now. Give it a moment and ask again."] };
  }
  const line =
    longUsd > shortUsd * 1.25 ? `longs took the bigger hit (${usd(longUsd)} vs ${usd(shortUsd)}), so the recent pressure ran downward`
    : shortUsd > longUsd * 1.25 ? `shorts took the bigger hit (${usd(shortUsd)} vs ${usd(longUsd)}), so the recent pressure ran upward`
    : `longs and shorts were hit about evenly (${usd(longUsd)} / ${usd(shortUsd)})`;
  const lead = totalUsd != null ? `${usd(totalUsd)} of BTC positions were liquidated in the last 24h` : 'BTC saw notable liquidations in the last 24h';
  return { text: [`${lead}, ${line}.`, METRIC_CTA] };
}

function maxPainReply(ins: BtcInsights): CopilotReply {
  const mp = ins.maxPain;
  if (!mp) return { text: ["I don't have a max-pain level right now. Give it a moment and ask again."] };
  return {
    text: [
      `BTC's max-pain price is $${num(mp.strike, 0)} (for the ${mp.date} options expiry).`,
      "That's the level where the most options expire worthless. Price often drifts toward it into expiry, though it's only one signal.",
      METRIC_CTA,
    ],
  };
}

function priceReply(ctx: CopilotContext, ins: BtcInsights): CopilotReply {
  const spot = ctx.spot ?? ins.spot;
  if (spot == null) return { text: ["I don't have a live BTC price right now. Give it a moment and ask again."] };
  const chg = ins.change24hPct != null ? ` It's ${signed(ins.change24hPct, 2)}% over the last 24h.` : '';
  return { text: [`BTC is $${num(spot, 0)} right now.${chg}`, METRIC_CTA] };
}

function change24hReply(ins: BtcInsights): CopilotReply {
  const chg = ins.change24hPct;
  if (chg == null) return { text: ["I don't have a 24h change reading right now. Give it a moment and ask again."] };
  const dir = chg > 0.05 ? 'up' : chg < -0.05 ? 'down' : 'flat';
  const at = ins.spot != null ? `, around $${num(ins.spot, 0)}` : '';
  return { text: [`BTC is ${dir} ${signed(chg, 2)}% over the last 24h${at}.`, METRIC_CTA] };
}

function openInterestReply(ins: BtcInsights): CopilotReply {
  const oi = ins.oiUsd;
  if (oi == null) return { text: ["I don't have an open-interest figure right now. Give it a moment and ask again."] };
  return {
    text: [
      `BTC open interest is about ${usd(oi)}. That's how much money is riding on open futures positions right now, a rough gauge of how much action is on the table.`,
      METRIC_CTA,
    ],
  };
}

function metricReply(metric: MetricKind, ctx: CopilotContext): CopilotReply {
  const ins = ctx.insights;
  if (!ins || !ins.available) {
    return { text: ["I can't reach the live market data right now. Give it a moment and ask again."] };
  }
  switch (metric) {
    case 'fear_greed':
      return fearGreedReply(ins);
    case 'funding':
      return fundingReply(ins);
    case 'liquidations':
      return liquidationsReply(ins);
    case 'max_pain':
      return maxPainReply(ins);
    case 'price':
      return priceReply(ctx, ins);
    case 'change_24h':
      return change24hReply(ins);
    case 'open_interest':
      return openInterestReply(ins);
  }
}

/* ------------------------------ my balance ------------------------------- */

/** "What's my wallet balance?" — the connected account's DUSDC, plainly. Shows
 *  the trading-account balance (what funds bets) + the wallet balance + a total,
 *  since a mint pulls from both. */
function balanceReply(ctx: CopilotContext): CopilotReply {
  const w = ctx.wallet;
  if (!w || !w.connected) {
    return { text: ['Connect your wallet (top-right) and I’ll show your DUSDC balance.'] };
  }
  if (w.walletBase === undefined) {
    return { text: ['One sec, I’m still loading your balance. Ask me again in a moment.'] };
  }
  const account = fromQuote(w.accountBase);
  const wallet = fromQuote(w.walletBase);
  const total = account + wallet;
  const fmt = (n: number) => `$${num(n, 2)}`;

  if (total <= 0) {
    return {
      text: [
        'Your DUSDC balance is $0.00 right now.',
        'You’ll need some test tokens to place a bet. Say “get test tokens” and I’ll drop some into your wallet, then ask me to set up a trade.',
      ],
    };
  }
  if (!w.hasAccount || account <= 0) {
    // It's all in the plain wallet; the trading account opens on the first bet.
    return {
      text: [
        `You’ve got ${fmt(wallet)} DUSDC in your wallet.`,
        'It moves into your trading account the first time you place a bet. Say “set up a trade” whenever you’re ready.',
      ],
    };
  }
  return {
    text: [
      `You’ve got ${fmt(total)} DUSDC ready to trade, ${fmt(account)} in your trading account and ${fmt(wallet)} in your wallet.`,
      'Want to put it to work? Say “set up a trade”, or tell me a direction.',
    ],
  };
}

/* ------------------------------ my portfolio ----------------------------- */

/** "How is my portfolio doing?" — how the trader's own bets are performing plus
 *  their balances, from the SAME positions the Portfolio screen shows. */
function portfolioReply(ctx: CopilotContext): CopilotReply {
  const w = ctx.wallet;
  if (!w || !w.connected) {
    return { text: ['Connect your wallet (top-right) and I’ll show how your bets are doing and your DUSDC balance.'] };
  }
  const walletLoading = w.walletBase === undefined;
  const account = fromQuote(w.accountBase);
  const wallet = walletLoading ? 0 : fromQuote(w.walletBase!);
  const free = account + wallet;
  const p = ctx.portfolio;
  const fmt = (n: number) => `$${num(n, 2)}`;
  const signedUsd = (n: number) => `${n >= 0 ? '+' : '−'}$${num(Math.abs(n), 2)}`;
  const freeLine = () =>
    walletLoading
      ? `You've also got ${fmt(account)} free in your trading account.`
      : account > 0 && wallet > 0
        ? `You've also got ${fmt(free)} DUSDC free to trade, ${fmt(account)} in your trading account and ${fmt(wallet)} in your wallet.`
        : `You've also got ${fmt(free)} DUSDC free to trade.`;

  // Still loading positions, or genuinely none open.
  const nothingOpen = !p || (p.openCount === 0 && p.claimableCount === 0 && p.settledLostCount === 0);
  if (nothingOpen) {
    return {
      text: [
        "You don't have any open bets right now.",
        free > 0
          ? `${fmt(free)} DUSDC is ready to trade${account > 0 && wallet > 0 && !walletLoading ? ` (${fmt(account)} in your trading account, ${fmt(wallet)} in your wallet)` : ''}.`
          : 'Your DUSDC balance is $0.00. Say “get test tokens” and I’ll drop some in so you can place your first bet.',
        'Say “set up a trade” or tell me a direction whenever you’re ready.',
      ],
    };
  }

  const text: string[] = [];
  if (p!.openCount > 0) {
    const dirWord = p!.unrealized > 0 ? 'up' : p!.unrealized < 0 ? 'down' : 'flat';
    const pctStr = signed(p!.unrealizedPct * 100, 1);
    if (p!.openCount === 1) {
      // A single open trade — name it (works for a bet opened anywhere: Kelly, the
      // ticket, or the surface — these come from the account's real positions).
      const label = p!.best?.label ?? p!.openLabel;
      if (p!.best) {
        text.push(
          `Your ${p!.best.label} bet is ${dirWord} ${signedUsd(p!.unrealized)} (${pctStr}%) right now, worth ${fmt(p!.openValue)}.`,
        );
      } else if (label) {
        // Open, but not live-priceable this moment (e.g. markets paused) → no PnL to
        // show, but confirm the trade so the trader still gets a real answer.
        text.push(
          `Your ${label} bet is still open, ${fmt(p!.openExposure)} staked. I can't price it live right now, so I don't have a PnL to show yet.`,
        );
      } else {
        text.push(`You've got 1 open bet, ${fmt(p!.openExposure)} staked.`);
      }
    } else {
      text.push(
        `You've got ${p!.openCount} open bets worth ${fmt(p!.openValue)} right now, and you're ${dirWord} ${signedUsd(p!.unrealized)} on them (${pctStr}%).`,
      );
      if (p!.best && p!.worst) {
        text.push(`Best: ${p!.best.label} (${signedUsd(p!.best.pnl)}). Weakest: ${p!.worst.label} (${signedUsd(p!.worst.pnl)}).`);
      }
    }
  }
  if (p!.claimableCount > 0) {
    const one = p!.claimableCount === 1;
    text.push(`${fmt(p!.claimable)} is waiting to be claimed from ${p!.claimableCount} settled ${one ? 'win' : 'wins'}. Open Portfolio to redeem ${one ? 'it' : 'them'}.`);
  }
  if (p!.settledLostCount > 0 && p!.openCount === 0 && p!.claimableCount === 0) {
    text.push(`${p!.settledLostCount} settled ${p!.settledLostCount === 1 ? 'bet' : 'bets'} didn't win this time.`);
  }
  text.push(freeLine());
  text.push('Want to add another? Say “set up a trade”, or “analyze BTC” for a read.');
  return { text };
}

/* ---------------------------- my track record ---------------------------- */

/** "Did I win my last trade? / what's my win rate? / how's my loss rate?" — a read
 *  of the trader's SETTLED bets (last result + running win/loss rate + streak), from
 *  the SAME history the Portfolio screen shows. The win-rate answer offers a "Share
 *  to X" card (the screen builds the image from its live history ref). */
function trackRecordReply(focus: 'last' | 'win_rate' | 'loss_rate', ctx: CopilotContext, ask?: 'win' | 'lose'): CopilotReply {
  const w = ctx.wallet;
  if (!w || !w.connected) {
    return { text: ['Connect your wallet (top-right) and I’ll pull up your track record.'] };
  }
  const rec = ctx.record;
  // Still loading, or genuinely no settled bets yet.
  if (!rec || rec.stats.total === 0) {
    return {
      text: [
        "You don't have any settled bets yet, so there's no track record to show.",
        'Once a bet settles I can tell you whether you won, and your win rate. Say “set up a trade” to place one.',
      ],
    };
  }
  const { stats, lastTrade } = rec;
  const signedUsd = (n: number) => `${n >= 0 ? '+' : '−'}$${num(Math.abs(n), 2)}`;
  const winWord = (n: number) => `${n} win${n === 1 ? '' : 's'}`;
  const lossWord = (n: number) => `${n} loss${n === 1 ? '' : 'es'}`;
  const betWord = (n: number) => `${n} settled bet${n === 1 ? '' : 's'}`;
  const streakLine =
    stats.streak && stats.streak.count >= 2
      ? ` You’re on a ${stats.streak.count}-bet ${stats.streak.result === 'won' ? 'winning' : 'losing'} run.`
      : '';

  if (focus === 'last') {
    const t = lastTrade;
    if (!t) return { text: ['I can’t find your last settled bet just yet. Give it a moment and ask again.'] };
    const side = t.band ? `range $${num(t.band.lower, 0)}–$${num(t.band.higher, 0)}` : `${t.up ? 'UP' : 'DOWN'} $${num(t.strike, 0)}`;
    const won = t.result === 'won';
    const wonDetail = `a ${side} bet that came back ${signedUsd(t.pnl)}`;
    const lostDetail = `a ${side} bet, down $${num(Math.abs(t.pnl), 2)}`; // magnitude — "down" already means a loss
    // Lead with a yes/no that matches HOW they asked. "Did I lose?" on a winning bet
    // answers "No"; "did I win?" on a losing bet answers "No". A neutral ask ("how
    // did my last bet go") just states the result.
    let lead: string;
    if (ask === 'lose') {
      lead = won ? `No, you didn’t lose it. Your last bet won, ${wonDetail}.` : `Yes, your last bet lost. It was ${lostDetail}.`;
    } else if (ask === 'win') {
      lead = won ? `Yes, your last bet won. It was ${wonDetail}.` : `No, that one didn’t win. Your last bet lost, ${lostDetail}.`;
    } else {
      lead = won ? `Your last bet won, ${wonDetail}.` : `Your last bet lost. It was ${lostDetail}.`;
    }
    return {
      text: [
        lead,
        `That puts you at ${winWord(stats.wins)} and ${lossWord(stats.losses)} across your ${betWord(stats.total)}.`,
        'Ask “what’s my win rate” for the full picture.',
      ],
    };
  }

  const winPct = pct(stats.winRate, 0);
  const lossPct = pct(1 - stats.winRate, 0);

  if (focus === 'loss_rate') {
    return {
      text: [
        `Your loss rate is ${lossPct}: ${stats.losses} of your ${betWord(stats.total)} didn’t pay out.${streakLine}`,
        `That’s a ${winPct} win rate, with ${signedUsd(stats.realizedPnl)} realized so far.`,
        'Ask “what’s my win rate” to see it as a card you can share.',
      ],
    };
  }

  // win_rate — the shareable one.
  return {
    text: [
      `Your win rate is ${winPct}: ${winWord(stats.wins)} out of ${betWord(stats.total)}.${streakLine}`,
      `You’re ${signedUsd(stats.realizedPnl)} realized across them.`,
      'Want to show it off? Share your track record card on X.',
    ],
    share: { kind: 'win_rate' },
  };
}

/* ------------------------------ explainers ------------------------------- */
// Plain-language answers to "how does X work?" — static (no live data), so a new
// trader can learn the mechanics inline. Kept jargon-free and short.

const EXPLAINERS: Record<ExplainTopic, string[]> = {
  leverage: [
    'Leverage multiplies your bet: a 3× UP bet gains 3× as fast, so the same stake can win more.',
    'The catch. If BTC moves against you far enough before the close, a leveraged bet closes early for $0 (a “knockout”). You can never lose more than you put in; higher leverage just means a smaller cushion. Say “set up a trade” and I’ll show you the exact knockout level.',
  ],
  range: [
    'A range bet wins if BTC settles between two prices you choose. Good when you think it’ll stay calm and drift sideways rather than pick a clear direction.',
    'Pick a low and a high; if the closing price lands inside, you win. Tap two points on the surface, or open the ticket and switch to Range.',
  ],
  binary: [
    'An UP bet wins if BTC settles ABOVE the price you pick; a DOWN bet wins if it settles at or below it.',
    'The closer your price is to where BTC is now, the safer the bet and the smaller the payout. Further away pays more but is less likely. Tell me a direction and I’ll set one up.',
  ],
  settlement: [
    'Each market has a fixed close time (some settle in about a minute). At the close, BTC’s price is checked once: if your side is right you win the payout, otherwise the bet is worth $0.',
    'It settles on the price AT the close, so a bet that’s winning midway can still flip. After it settles, you redeem your winnings. Just say “redeem my winnings”.',
  ],
  loss: [
    'The most you can ever lose is what you put in. A losing bet simply settles at $0. No margin calls, nothing owed.',
    'With leverage there’s one wrinkle: if BTC moves against you far enough before the close, the bet closes early for $0 (a “knockout”). But you still never lose more than your stake.',
  ],
  fees: [
    'The app charges a small fee on each trade (currently 2% of your bet). That’s how it earns, and it’s already included in the price you see before you confirm.',
    'The pool that pays winners earns a separate spread, which goes to the people who supply that pool, not to the app. No hidden costs and no subscription.',
  ],
  funds: [
    'You bet with DUSDC. A test-dollar on Sui testnet, not real money. Grab some free from the faucet and it lands in your wallet ready to trade.',
    'Ask me “what’s my balance” any time to see how much you have.',
  ],
  payout: [
    'Your payout depends on the odds: the less likely your bet, the more it pays. A ~70% chance pays about 1.4× your stake; a ~25% longshot pays around 4×.',
    'I always show the exact odds and payout before you place anything. Say “safe up bet” or “longshot down bet” to see one.',
  ],
  predict: [
    'This app is a prediction market for BTC: you bet which way the price goes by a set close time, using the live surface on the left instead of a plain list. Pick UP, DOWN, or a range, set your stake, and you see the exact odds and payout before you confirm.',
    'I’m Kelly, your co-pilot. I can read the market, find or analyze a bet, and set one up for you, though you always sign it yourself. Try “analyze BTC”, “safe up bet”, or “what’s a range bet?”.',
  ],
  option: [
    'An option is really just a bet on where a price goes by a set time. On Skew you don’t need the finance jargon: you pick a direction, UP or DOWN, choose a close time, and stake an amount. That’s the whole thing.',
    'Say “analyze BTC” for a live read, or “safe up bet” and I’ll show you a real one with the exact odds.',
  ],
  call_put: [
    'A call is a bet that the price goes UP; a put is a bet that it goes DOWN. Skew keeps it that simple, no options desk required: you just pick UP or DOWN.',
    'Tell me a direction, like “up bet” or “down bet”, and I’ll set one up for you.',
  ],
  strike: [
    'A strike is the price line your bet is measured against. An UP bet wins if BTC closes above your strike; a DOWN bet wins if it closes at or below it.',
    'The closer the strike sits to where BTC trades now, the safer the bet and the smaller the payout. Say “find the 65k strike” to light one up on the surface.',
  ],
  expiry: [
    'The expiry is the close time when your bet is settled. Skew runs short markets: some settle in about a minute, others over an hour.',
    'At the expiry, BTC’s price is checked once and your bet either wins its payout or settles at $0. Ask “which expiry is better?” to compare the live ones.',
  ],
  implied_vol: [
    'The volatility number is how big a price swing the market expects before the close. Higher means a wilder ride, so far-off bets get more likely and pay less.',
    'You never have to calculate it: it’s already baked into every price and payout I show you. Ask “how volatile is BTC right now?” for the live reading.',
  ],
  premium: [
    'The premium is just the cost of a bet, the amount you stake to open it. Skew shows it up front, with the exact payout next to it, before you confirm anything.',
    'A more likely bet costs more for a smaller payout; a longshot costs less and pays more. Say “safe up bet” or “longshot” to compare.',
  ],
  moneyness: [
    '“In the money” means your bet is currently winning, with the price on your side. “Out of the money” means it’s currently losing, and “at the money” means it’s right on the line.',
    'It can flip until the close, since only the price AT the expiry counts. Ask “analyze my strike” to see where yours stands.',
  ],
  surface: [
    'The surface is the live 3-D map on the left. Every point is a real bet: left to right is the price level, front to back is the close time, and the height and color show how lively that area is.',
    'Tap any point to open a ticket for that exact bet, or just tell me what you want, like “safe up bet”, and I’ll find it. Say “what can I bet on?” to see the live markets.',
  ],
  vault: [
    'The vault is the shared pool that pays the winners. When you win, your payout comes from it; when bets lose, the pool grows.',
    'Anyone can supply the vault to earn a share of the spread, and that reward goes to the suppliers, not to the app. It’s optional, and separate from just placing bets.',
  ],
};

function explainReply(topic: ExplainTopic): CopilotReply {
  return { text: EXPLAINERS[topic] };
}

/* --------------------------- surface overview --------------------------- */

/** "What can I bet on?" — the surface's live expiries: how many, and the range
 *  from the soonest to the furthest, read straight from the live candidates. */
function marketsOverviewReply(ctx: CopilotContext): CopilotReply {
  const live = ctx.candidates.filter((c) => c.market.expiry > ctx.now);
  if (live.length === 0) {
    return { text: ["There's no live market right now. A fresh one opens about every minute, so check back in a moment."] };
  }
  const exps = live.map((c) => c.market.expiry).sort((a, b) => a - b);
  const soonest = exps[0];
  const furthest = exps[exps.length - 1];
  if (live.length === 1) {
    return {
      text: [
        `There's one live market on the surface right now, settling in ${timeLeftLabel(soonest, ctx.now)}. A fresh one opens about every minute.`,
        'You can bet it UP, DOWN, or a range. Tell me a direction and I’ll set it up.',
      ],
    };
  }
  return {
    text: [
      `There are ${live.length} live markets on the surface right now, settling anywhere from ${timeLeftLabel(soonest, ctx.now)} out to ${timeLeftLabel(furthest, ctx.now)}.`,
      'Each one you can bet UP, DOWN, or a range on. Tell me a direction and I’ll set one up, or say “next market” to step through them.',
    ],
  };
}

/** "Where's the biggest payout / longest shot?" — scans every live market's ladder
 *  (both sides of each mintable rung) for the highest fair payout multiple, then
 *  loads it as a bet. The payout is the fair 1/chance figure the surface implies;
 *  the ticket still shows the exact chain quote before you place. */
function biggestPayoutReply(ctx: CopilotContext): CopilotReply {
  const now = ctx.now;
  const live = ctx.candidates.filter((c) => c.market.expiry > now);
  if (live.length === 0) {
    return { text: ["There's no live market right now, so there's nothing to bet on yet. A fresh one opens about every minute."] };
  }
  type Shot = { payout: number; prob: number; isUp: boolean; strike: number; marketId: string; expiry: number };
  let best: Shot | null = null;
  for (const c of live) {
    const rungs = buildLadder(c.pricer, c.market.admission_tick_size ?? '1000000000');
    for (const r of rungs) {
      const sides: Shot[] = [
        { payout: r.payoutUp, prob: r.chanceAbove, isUp: true, strike: r.strike, marketId: c.market.expiry_market_id, expiry: c.market.expiry },
        { payout: payoutMultiple(1 - r.chanceAbove), prob: 1 - r.chanceAbove, isUp: false, strike: r.strike, marketId: c.market.expiry_market_id, expiry: c.market.expiry },
      ];
      for (const s of sides) {
        // Guard the un-quotable extreme (chance → 0) so the "longest shot" is still a real bet.
        if (s.prob > 0.03 && (!best || s.payout > best.payout)) best = s;
      }
    }
  }
  if (!best) {
    return { text: ["I couldn't find a clean longshot on the surface right now. Ask me to analyze BTC, or tell me a direction and I’ll set up a bet."] };
  }
  const spot = ctx.spot ?? null;
  const dirLabel = best.isUp ? `UP $${num(best.strike, 0)}` : `DOWN $${num(best.strike, 0)}`;
  const moveWord = best.isUp ? `get above $${num(best.strike, 0)}` : `drop below $${num(best.strike, 0)}`;
  return {
    text: [
      `The longest shot on the surface right now is ${dirLabel}, settling in ${timeLeftLabel(best.expiry, now)} and paying about ${best.payout.toFixed(2)}× if it hits.`,
      `It needs BTC to ${moveWord}${spot != null ? ` from $${num(spot, 0)}` : ''} by then, about a ${pct(best.prob, 0)} chance. Big payout, long odds.`,
      'I’ve set it up below and lit it on the surface. Not financial advice, just the biggest mintable payout live.',
    ],
    bet: {
      marketId: best.marketId,
      expiry: best.expiry,
      dir: best.isUp ? 'up' : 'down',
      isUp: best.isUp,
      strikePrice: best.strike,
      prob: best.prob,
      payoutMult: best.payout,
      conviction: 'longshot',
      timeLeftLabel: timeLeftLabel(best.expiry, now),
    },
  };
}

function helpReply(): CopilotReply {
  return {
    text: [
      "I'm Kelly, your Predict co-pilot. I can read the BTC market for you, or set up a bet. Just tell me the direction.",
      'Try “analyze BTC”, “safe up bet”, or “longshot down bet for the next hour”.',
      'New to this? Ask me “how does this work?”, “what’s a call option?”, or “what is the surface?” and I’ll explain in plain English.',
      "If I missed your question or you've got feedback, reach out to the dev on X and they'll take a look.",
    ],
    link: { label: 'Message the dev on X', href: 'https://x.com/0xdegend' },
  };
}

/* ------------------------------ onboarding ------------------------------- */
// The first-run journey, state-aware from ctx.wallet: (1) not signed in — you can
// still ask anything about the market; (2) signed in, no trading account — offer to
// create it; (3) account but no funds — offer the test-token airdrop; (4) all set.
// The `action` cards run the real flow in the screen (createAccount / grant); nothing
// here signs or spends. Plain language, no jargon.

/** Free DUSDC across the trading account + wallet (human units). */
function readyFunds(w: NonNullable<CopilotContext['wallet']>): number {
  return fromQuote(w.accountBase) + (w.walletBase != null ? fromQuote(w.walletBase) : 0);
}

function onboardingReply(ctx: CopilotContext): CopilotReply {
  const w = ctx.wallet;
  if (!w || !w.connected) {
    return {
      text: [
        "You don't need to sign in to explore. Ask me anything about the market, like “fear and greed”, “analyze BTC”, or “what's the funding rate”.",
        'When you want to actually place a bet, tap Connect (top right) to sign in. Then I can get you some test tokens and set up your free trading account.',
      ],
    };
  }
  // Brand-new, empty wallet the app can still fund → tokens first (the grant also
  // covers gas), then the account.
  if (w.grantEligible) {
    return {
      text: [
        "You're signed in, nice. To start trading you'll need some test tokens, plus a little gas to go with them. It’s all play money on testnet, not real funds.",
        'Want me to drop some into your wallet to get you going?',
      ],
      action: { kind: 'get_tokens', label: 'Get test tokens' },
    };
  }
  const funds = readyFunds(w);
  if (!w.hasAccount) {
    if (funds <= 0) {
      // Empty, but the one-time grant isn't available (already used, or off) → faucet.
      return {
        text: [
          "You're signed in. You’ll need some test tokens to trade, grab them from the testnet faucet, then I’ll set up your trading account.",
        ],
      };
    }
    return {
      text: [
        "You're signed in and funded. Next you'll need a trading account, a one-time free setup that holds your funds and positions.",
        'Want me to create it for you now?',
      ],
      action: { kind: 'create_account', label: 'Create trading account' },
    };
  }
  if (funds <= 0) {
    return {
      text: [
        'Your trading account is set up, but it’s out of test tokens. You can top up from the testnet faucet.',
        'Once you’ve got some, tell me a direction and I’ll set up a bet.',
      ],
    };
  }
  return {
    text: [
      "You're all set: signed in, trading account ready, and funded.",
      'Tell me a direction and I’ll set up a bet, like “safe up bet”, or say “analyze BTC” for a read.',
    ],
  };
}

function createAccountReply(ctx: CopilotContext): CopilotReply {
  const w = ctx.wallet;
  if (!w || !w.connected) {
    return { text: ['To create your trading account, first tap Connect (top right) to sign in. Then I’ll set it up in one tap.'] };
  }
  if (w.hasAccount) {
    return { text: ["You've already got a trading account, so you're ready to bet. Try “safe up bet”, or “get test tokens” if you need funds."] };
  }
  return {
    text: ['A trading account is a one-time, free on-chain setup that holds your test funds and positions. Want me to create it now?'],
    action: { kind: 'create_account', label: 'Create trading account' },
  };
}

function getTokensReply(ctx: CopilotContext): CopilotReply {
  const w = ctx.wallet;
  if (!w || !w.connected) {
    return { text: ['To get test tokens, first tap Connect (top right) to sign in, then I’ll drop some DUSDC into your wallet.'] };
  }
  if (w.grantEligible) {
    return {
      text: [
        'I can get you some free test tokens (DUSDC) to trade with, plus a little gas. It’s play money on testnet, not real funds.',
        'Want me to send some to your wallet?',
      ],
      action: { kind: 'get_tokens', label: 'Get test tokens' },
    };
  }
  // Not eligible: the one-time grant only goes to a brand-new, near-empty wallet.
  if (readyFunds(w) > 0) {
    return { text: ["You've already got test tokens in your wallet, so you're ready to trade. Tell me a direction and I’ll set one up."] };
  }
  return { text: ['I can only auto-send test tokens to a brand-new wallet, and yours is already set up. You can top up from the testnet faucet instead.'] };
}

function positioningReply(ctx: CopilotContext): CopilotReply {
  const funding = ctx.insights?.funding.binancePct ?? ctx.insights?.funding.avgPct ?? null;
  const lines = positioningLines(ctx.positioning ?? null, funding);
  if (lines.length === 0) return { text: ['I can’t read the positioning data right now — give it a moment and ask again.'] };
  return { text: ['Here’s how everyone’s positioned right now:', ...lines] };
}

function flowReply(ctx: CopilotContext): CopilotReply {
  const lines = flowLines(ctx.positioning ?? null);
  if (lines.length === 0) return { text: ['I don’t have fresh ETF flow data right now — try again in a moment.'] };
  return { text: lines };
}

function optionsMarketReply(ctx: CopilotContext): CopilotReply {
  const lines = optionsLines(ctx.positioning ?? null);
  if (lines.length === 0) return { text: ['I can’t read the options market right now — give it a moment and ask again.'] };
  return { text: ['Here’s what the wider options market is showing:', ...lines] };
}

/** "Why is BTC moving? / what's driving this? / any news?" — names the single
 *  biggest live driver from the hard data, then what X is discussing. Composed by
 *  the shared, tested engine (buildNarrative), which prefers a later LLM read when
 *  the feed carries one. Reuses insights + positioning already in context — the
 *  only extra fetch is the slow (5-min) chatter aggregate. */
function whyMovingReply(ctx: CopilotContext): CopilotReply {
  const n = buildNarrative({
    feed: ctx.narrative ?? null,
    insights: ctx.insights,
    positioning: ctx.positioning ?? null,
    closes: ctx.closes,
    now: ctx.now,
  });
  return { text: n.text };
}

/** "What's happening today? / any events? / is there FOMC?" — the day's scheduled
 *  market-moving calendar, composed by the shared engine (buildEventsReply). The
 *  screen may re-phrase this through the AI tier (events are also in the AiContext),
 *  falling back to exactly these lines. */
function eventsReply(ctx: CopilotContext): CopilotReply {
  const text = buildEventsReply(ctx.events ?? null, ctx.now);
  const events = notableEvents(ctx.events ?? null)
    .slice(0, 5)
    .map((e) => ({ title: eventName(e), at: e.at, when: relTime(e, ctx.now) }));
  // Offer a Share-to-X card only when there's a real lineup to show off (a
  // quiet-calendar day has nothing worth posting).
  const share: ShareCard | undefined =
    events.length > 0 ? { kind: 'events', events, headline: ctx.events?.headline ?? null } : undefined;
  return { text, share };
}

export function respondToIntent(intent: CopilotIntent, ctx: CopilotContext): CopilotReply {
  switch (intent.kind) {
    case 'analyze':
      return analyzeReply(ctx);
    case 'analyze_strike':
      return analyzeStrikeReply(ctx, intent.price, intent.dir);
    case 'find_strike':
      return findStrikeReply(intent.price, intent.dir, ctx);
    case 'explain':
      return explainReply(intent.topic);
    case 'best_value':
      return bestValueReply(ctx);
    case 'markets_overview':
      return marketsOverviewReply(ctx);
    case 'biggest_payout':
      return biggestPayoutReply(ctx);
    case 'positioning':
      return positioningReply(ctx);
    case 'flow':
      return flowReply(ctx);
    case 'options_market':
      return optionsMarketReply(ctx);
    case 'why_moving':
      return whyMovingReply(ctx);
    case 'events':
      return eventsReply(ctx);
    case 'onboarding':
      return onboardingReply(ctx);
    case 'create_account':
      return createAccountReply(ctx);
    case 'get_tokens':
      return getTokensReply(ctx);
    case 'adjust_ticket':
      return adjustReply(intent, ctx);
    case 'next_market':
      return nextMarketReply(ctx);
    case 'metric':
      return metricReply(intent.metric, ctx);
    case 'recommend':
      return recommendReply(ctx);
    case 'balance':
      return balanceReply(ctx);
    case 'portfolio':
      return portfolioReply(ctx);
    case 'track_record':
      return trackRecordReply(intent.focus, ctx, intent.ask);
    case 'odds':
      return oddsReply(intent.level, intent.dir, ctx, intent.horizon);
    case 'volatility':
      return volatilityReply(ctx);
    case 'skew':
      return skewReply(ctx);
    case 'term_structure':
      return termStructureReply(intent.dir, ctx);
    case 'no_arb':
      return noArbReply(ctx);
    case 'surface_shape':
      return surfaceShapeReply(ctx);
    case 'reality_check':
      return realityCheckReply(intent.level, intent.dir, ctx);
    case 'directional_bet':
      return betReply(intent.dir, intent.conviction, intent.horizon, ctx, intent.target);
    // The screen intercepts these before they reach here — start_trade runs the
    // guided wizard (lib/copilot/flow); busiest_strike fetches the orders feed; and
    // close_position redeems on-chain. Handled defensively for a total switch.
    case 'start_trade':
    case 'busiest_strike':
    case 'surface_volume':
    case 'close_position':
    case 'help':
      return helpReply();
  }
}
