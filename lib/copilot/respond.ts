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
import { num, pct } from '@/lib/format';
import { toFloat } from '@/config/scale';
import { buildMarketRead, directionStance } from '@/lib/insights/market-read';
import { strikeForDirectionFair } from '@/lib/sui/v2/invert';
import { directionFair, payoutMultiple } from '@/lib/svi/invert';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { CopilotIntent, Conviction, BetDirection, Horizon } from './intents';

/** A market we can actually price (has a live pricer → forward + SVI). */
export interface BetCandidate {
  market: V2Market;
  pricer: LivePricer;
}

export interface CopilotContext {
  insights: BtcInsights | null;
  candidates: BetCandidate[];
  now: number;
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

/** Pick the market a horizon points at, from those we can price. */
function pickCandidate(candidates: BetCandidate[], horizon: Horizon, now: number): BetCandidate | null {
  const open = candidates.filter((c) => c.market.expiry > now);
  if (open.length === 0) return null;
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
    return { text: ["I can't reach the live market data right now — give it a moment and ask again."] };
  }
  const text = [read.headline, ...read.lines.map((l) => l.text)];
  const soonest = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (soonest) text.push(`The soonest market you can bet on settles in ${timeLeftLabel(soonest.market.expiry, ctx.now)}.`);
  text.push("Want me to set one up? Try “safe up bet”, “longshot down bet”, or add “for the next hour”.");
  return { text };
}

function nextMarketReply(ctx: CopilotContext): CopilotReply {
  const cand = pickCandidate(ctx.candidates, 'soonest', ctx.now);
  if (!cand) {
    return { text: ["There's no live market right now — a new one opens about every minute, so check back in a moment."] };
  }
  const { market, pricer } = cand;
  return {
    text: [
      `The next market settles in ${timeLeftLabel(market.expiry, ctx.now)}.`,
      `BTC is around $${num(pricer.forward, 0)} right now — that's the level it settles against. Bet UP if you think it'll be higher by then, or DOWN if lower.`,
      'Want me to set one up? Try “safe up bet”, “longshot down bet”, or add “for the next hour”.',
    ],
  };
}

function betReply(dir: BetDirection, conviction: Conviction, horizon: Horizon, ctx: CopilotContext): CopilotReply {
  const cand = pickCandidate(ctx.candidates, horizon, ctx.now);
  if (!cand) {
    return { text: ["There's no live market to bet on right now — check back in a moment and I'll set one up."] };
  }
  const { market, pricer } = cand;
  const isUp = dir === 'up';
  const target = CONVICTION_TARGET[conviction];
  const strikeScaled = strikeForDirectionFair(target, pricer.forward, pricer.svi, market.admission_tick_size, isUp);
  const strikePrice = toFloat(strikeScaled);
  const prob = directionFair(strikePrice, pricer.forward, pricer.svi, isUp);
  const payoutMult = payoutMultiple(prob);
  const label = timeLeftLabel(market.expiry, ctx.now);

  const text = [
    `Here's ${convictionLead[conviction]} ${dir.toUpperCase()} bet on the market settling ${label}.`,
    `It wins if BTC is ${isUp ? 'above' : 'below'} $${num(strikePrice, 0)} at the end — it's around $${num(pricer.forward, 0)} now.`,
    `The odds work out to about ${pct(prob, 0)}, and it pays about ${payoutMult.toFixed(2)}× your stake if it wins.`,
  ];
  const stance = directionStance(ctx.insights, isUp);
  if (stance === 'aligned') text.push('Good sign: the wider market is leaning the same way right now.');
  else if (stance === 'against') text.push('Worth knowing: the wider market is leaning against this right now.');
  text.push('I’ve marked it on the surface — tap “Place this bet” to open your ticket and trade it.');

  return {
    text,
    bet: { marketId: market.expiry_market_id, expiry: market.expiry, dir, isUp, strikePrice, prob, payoutMult, conviction, timeLeftLabel: label },
  };
}

function helpReply(): CopilotReply {
  return {
    text: [
      "I'm your Predict co-pilot. I can read the BTC market for you, or set up a bet — just tell me the direction.",
      'Try “analyze BTC”, “safe up bet”, or “longshot down bet for the next hour”.',
    ],
  };
}

export function respondToIntent(intent: CopilotIntent, ctx: CopilotContext): CopilotReply {
  switch (intent.kind) {
    case 'analyze':
      return analyzeReply(ctx);
    case 'next_market':
      return nextMarketReply(ctx);
    case 'directional_bet':
      return betReply(intent.dir, intent.conviction, intent.horizon, ctx);
    // The screen intercepts start_trade to run the guided wizard (lib/copilot/flow)
    // before it ever reaches here; handled defensively so the switch stays total.
    case 'start_trade':
    case 'help':
      return helpReply();
  }
}
