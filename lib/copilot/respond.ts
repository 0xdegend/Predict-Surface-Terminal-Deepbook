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
import { strikeForDirectionFair } from '@/lib/sui/v2/invert';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { upFair, totalVariance } from '@/lib/svi/svi';
import { buildSurface, type SmileInput } from '@/lib/svi/surface';
import { directionFair, payoutMultiple } from '@/lib/svi/invert';
import type { PortfolioSummary } from '@/lib/portfolio/v2';
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
  } | null;
  /** Every live expiry's smile (the same inputs the 3-D surface is built from),
   *  for the no-arb check. Needs ≥2 expiries. */
  surfaceInputs?: SmileInput[];
  /** 1-minute BTC closes (oldest → newest), for the empirical reality check. */
  closes?: number[] | null;
  /** The trader's own book roll-up, for "how is my portfolio doing?" — computed
   *  from the SAME positions the Portfolio screen shows. Null until it loads. */
  portfolio?: PortfolioSummary | null;
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

export interface CopilotReply {
  text: string[];
  bet?: BetSuggestion;
  /** A strike to light up on the surface WITHOUT suggesting a full bet — the screen
   *  loads it into the store selection. Used by "find me the $X strike". */
  highlight?: { marketId: string; strikePrice: number; isUp: boolean };
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
    return {
      text: [
        "Nothing jumps out as clear value on this market right now. The surface is pricing moves about as often as they've actually happened lately. That's a fair, efficient market.",
        'If you just want a solid bet, say “safe up bet”; or ask me to “analyze this strike”.',
      ],
    };
  }
  return {
    text: [
      `Best value I can find on the ${windowAdj(market.expiry, ctx.now)} market: ${best.isUp ? 'UP' : 'DOWN'} $${num(best.strike, 0)}.`,
      `The surface gives it about ${pct(best.implied, 0)} to win (pays ~${payoutMultiple(best.implied).toFixed(2)}×), but across the last ${best.samples.toLocaleString()} similar ${minutesToExpiry}-minute windows BTC actually landed there about ${pct(best.empirical, 0)} of the time. Better odds than the price is asking for.`,
      'Not financial advice, and past moves are only a guide. I’ve highlighted it on the surface. Say “up bet” / “down bet” to trade it, or “analyze this strike”.',
    ],
    highlight: { marketId: market.expiry_market_id, strikePrice: best.strike, isUp: best.isUp },
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
        'You’ll need some testnet DUSDC to place a bet. Grab it from the faucet, then ask me to set up a trade.',
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
          : 'Your DUSDC balance is $0.00. Grab some testnet DUSDC from the faucet to place your first bet.',
        'Say “set up a trade” or tell me a direction whenever you’re ready.',
      ],
    };
  }

  const text: string[] = [];
  if (p!.openCount > 0) {
    const dirWord = p!.unrealized > 0 ? 'up' : p!.unrealized < 0 ? 'down' : 'flat';
    const one = p!.openCount === 1;
    text.push(
      `You've got ${p!.openCount} open ${one ? 'bet' : 'bets'} worth ${fmt(p!.openValue)} right now, and you're ${dirWord} ${signedUsd(p!.unrealized)} on ${one ? 'it' : 'them'} (${signed(p!.unrealizedPct * 100, 1)}%).`,
    );
    if (p!.best && p!.worst) {
      text.push(`Best: ${p!.best.label} (${signedUsd(p!.best.pnl)}). Weakest: ${p!.worst.label} (${signedUsd(p!.worst.pnl)}).`);
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
    'This is a prediction market on BTC: you bet which way the price goes by a set close time, using the live surface on the left.',
    'I’m your co-pilot, I can read the market, find or analyze a strike, suggest a bet and place it for you. Try “analyze BTC”, “safe up bet”, or “what’s a range bet?”.',
  ],
};

function explainReply(topic: ExplainTopic): CopilotReply {
  return { text: EXPLAINERS[topic] };
}

function helpReply(): CopilotReply {
  return {
    text: [
      "I'm your Predict co-pilot. I can read the BTC market for you, or set up a bet. Just tell me the direction.",
      'Try “analyze BTC”, “safe up bet”, or “longshot down bet for the next hour”.',
    ],
  };
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
    case 'reality_check':
      return realityCheckReply(intent.level, intent.dir, ctx);
    case 'directional_bet':
      return betReply(intent.dir, intent.conviction, intent.horizon, ctx, intent.target);
    // The screen intercepts these before they reach here — start_trade runs the
    // guided wizard (lib/copilot/flow); busiest_strike fetches the orders feed; and
    // close_position redeems on-chain. Handled defensively for a total switch.
    case 'start_trade':
    case 'busiest_strike':
    case 'close_position':
    case 'help':
      return helpReply();
  }
}
