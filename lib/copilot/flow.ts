/**
 * lib/copilot/flow.ts — the co-pilot's GUIDED trade wizard: a small state machine
 * that walks a trader through one bet, one question at a time — strike → up/down →
 * amount → leverage → review — then hands back a complete, mintable suggestion the
 * UI loads into the ticket (the trader still confirms + signs; nothing auto-mints).
 *
 * Unlike respondToIntent (stateless, one-shot), this is stateful: the screen holds
 * a `TradeFlow` and feeds each reply back through `advanceFlow`. Kept pure (no
 * fetch, no React) so it's unit-tested; all live data (every open market + its
 * pricer, and now) is passed in via FlowContext.
 *
 * MARKET RUNWAY: the wizard PINS a market with enough time left to finish (these
 * markets can be ~1 minute, far shorter than a multi-step chat), and if the pinned
 * one is about to close it hops to the next one with a heads-up — so a slow setup
 * can't die on an expiring market. Every number is validated against the SAME
 * chain-derived limits the ticket uses (quotable band, the strike's leverage cap).
 */
import { toFloat, fromFloat, toQuote, fromQuote } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { leverageSliderMax, quantityForStake, winPayout, MIN_STAKE_BASE } from '@/lib/sui/v2/quote';
import { directionFair } from '@/lib/svi/invert';
import { upFair } from '@/lib/svi/svi';
import { num } from '@/lib/format';
import { timeLeftLabel } from './respond';
import type { CopilotReply, BetSuggestion, BetCandidate } from './respond';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export type FlowStep = 'strike' | 'direction' | 'amount' | 'leverage' | 'review';

export interface TradeFlow {
  step: FlowStep;
  /** The market the wizard is building on (pinned; hops if it's about to close). */
  marketId?: string;
  strikePrice?: number; // snapped admission-grid price
  isUp?: boolean;
  amount?: number; // DUSDC
  leverage?: number;
}

export interface FlowContext {
  candidates: BetCandidate[]; // every open market we can price
  now: number;
}

export interface FlowResult {
  /** Next flow state, or null when the wizard ends (cancelled or no market). */
  flow: TradeFlow | null;
  reply: CopilotReply;
}

const CANCEL = /\b(cancel|stop|never ?mind|quit|forget it|exit)\b/;

/** Prefer a market with room to finish the wizard, and re-pin before the current
 *  one closes — these markets are short, and a chat setup takes a while. */
const FLOW_RUNWAY_MS = 90_000; // start on a market with ≥ 90s left when we can
const FLOW_SWITCH_MS = 25_000; // hop off the pinned market once it drops under 25s

function openSorted(ctx: FlowContext): BetCandidate[] {
  return ctx.candidates.filter((c) => c.market.expiry > ctx.now).sort((a, b) => a.market.expiry - b.market.expiry);
}

/** Soonest market that still has runway to finish the flow; else the soonest open. */
function pickWithRunway(ctx: FlowContext): BetCandidate | null {
  const open = openSorted(ctx);
  return open.find((c) => c.market.expiry - ctx.now >= FLOW_RUNWAY_MS) ?? open[0] ?? null;
}

/** Keep the pinned market while it has time; otherwise hop to a fresher one. */
function resolveMarket(ctx: FlowContext, flow: Pick<TradeFlow, 'marketId'>): { cand: BetCandidate | null; switched: boolean } {
  const open = openSorted(ctx);
  const pinned = flow.marketId ? open.find((c) => c.market.expiry_market_id === flow.marketId) : undefined;
  if (pinned && pinned.market.expiry - ctx.now > FLOW_SWITCH_MS) return { cand: pinned, switched: false };
  const fresh = pickWithRunway(ctx);
  const switched = !!flow.marketId && (!fresh || fresh.market.expiry_market_id !== flow.marketId);
  return { cand: fresh, switched };
}

/** Pull the first number out of a reply: "$65,000" → 65000, "65k" → 65000,
 *  "2.5x" → 2.5. Returns null when there's no number to read. */
function parseNumber(text: string): number | null {
  const t = text.toLowerCase().replace(/[$,]/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1000;
  return Number.isFinite(n) ? n : null;
}

function parseDirection(text: string): boolean | null {
  const t = text.toLowerCase();
  if (/\b(above|up|higher|over|rise|rises|bull)\b/.test(t)) return true;
  if (/\b(below|down|lower|under|fall|falls|bear)\b/.test(t)) return false;
  return null;
}

const minStake = () => fromQuote(MIN_STAKE_BASE);

/** Max leverage the chain admits at this strike + direction — the exact cap the
 *  ticket's leverage slider uses. */
function maxLeverageFor(strikeFloat: number, isUp: boolean, market: V2Market, pricer: LivePricer): number {
  const entryProb = directionFair(strikeFloat, pricer.forward, pricer.svi, isUp);
  return leverageSliderMax(entryProb, toFloat(market.max_admission_leverage));
}

type FilledFlow = Required<Pick<TradeFlow, 'strikePrice' | 'isUp' | 'amount' | 'leverage'>>;

/** Assemble the finished, mintable suggestion once every slot is filled. */
function reviewBet(f: FilledFlow, market: V2Market, pricer: LivePricer, now: number): BetSuggestion {
  const entryProb = directionFair(f.strikePrice, pricer.forward, pricer.svi, f.isUp);
  const stakeBase = toQuote(f.amount);
  const qty = quantityForStake(stakeBase, entryProb, f.leverage);
  const winAmount = fromQuote(winPayout(qty, entryProb, f.leverage));
  const payoutMult = f.amount > 0 ? winAmount / f.amount : 1;
  const conviction = entryProb > 0.6 ? 'safe' : entryProb < 0.35 ? 'longshot' : 'even';
  return {
    marketId: market.expiry_market_id,
    expiry: market.expiry,
    dir: f.isUp ? 'up' : 'down',
    isUp: f.isUp,
    strikePrice: f.strikePrice,
    prob: entryProb,
    payoutMult,
    conviction,
    timeLeftLabel: timeLeftLabel(market.expiry, now),
    amount: f.amount,
    leverage: f.leverage,
  };
}

function reviewReply(f: FilledFlow, market: V2Market, pricer: LivePricer, now: number): FlowResult {
  return {
    flow: { step: 'review', marketId: market.expiry_market_id, ...f },
    reply: {
      text: ["Here's your trade — check it over, then tap Trade it to place it (or Edit to change something)."],
      bet: reviewBet(f, market, pricer, now),
    },
  };
}

/** Begin the wizard. */
export function startFlow(ctx: FlowContext): FlowResult {
  const { cand } = resolveMarket(ctx, {});
  if (!cand) {
    return { flow: null, reply: { text: ["There's no live market to trade right now — check back in a moment."] } };
  }
  const price = num(cand.pricer.forward, 0);
  return {
    flow: { step: 'strike', marketId: cand.market.expiry_market_id },
    reply: {
      text: [
        `Let's build your trade on the market settling in ${timeLeftLabel(cand.market.expiry, ctx.now)}.`,
        `What price do you want to bet on? BTC is around $${price} now — type a strike, e.g. ${price}.`,
      ],
    },
  };
}

/** Feed the trader's reply into the active wizard and get the next question (or
 *  the final review). Resolves a live market first, hopping (with a heads-up) if
 *  the pinned one is about to close. */
export function advanceFlow(flow: TradeFlow, message: string, ctx: FlowContext): FlowResult {
  if (CANCEL.test(message.toLowerCase())) {
    return { flow: null, reply: { text: ['Okay, cancelled — no trade set up. Ask me anything else whenever you like.'] } };
  }
  const { cand, switched } = resolveMarket(ctx, flow);
  if (!cand) {
    return { flow: null, reply: { text: ["That market closed and there isn't another open right now — say “set up a trade” to try again in a moment."] } };
  }
  const { market, pricer } = cand;
  const marketId = market.expiry_market_id;

  // A market hop carries the strike over (it's a price) but re-prices everything
  // against the fresher market — announce it so the changing odds make sense.
  const note = switched ? `Heads up — that market was about to close, so I moved you to the next one (it settles in ${timeLeftLabel(market.expiry, ctx.now)}).` : null;
  const withNote = (r: FlowResult): FlowResult => (note ? { ...r, reply: { ...r.reply, text: [note, ...r.reply.text] } } : r);

  switch (flow.step) {
    case 'strike': {
      const raw = parseNumber(message);
      if (raw == null) {
        return withNote({ flow: { ...flow, marketId }, reply: { text: [`I didn't catch a price there. Type a strike like ${num(pricer.forward, 0)}.`] } });
      }
      const strikePrice = toFloat(snapStrikeToAdmission(fromFloat(raw), market.admission_tick_size));
      const up = upFair(strikePrice, pricer.forward, pricer.svi);
      const minP = toFloat(market.min_entry_probability);
      const maxP = toFloat(market.max_entry_probability);
      if (up <= minP || up >= maxP) {
        return withNote({ flow: { ...flow, marketId }, reply: { text: [`$${num(strikePrice, 0)} is too far from the current price to trade here. Try something within a few hundred dollars of $${num(pricer.forward, 0)}.`] } });
      }
      return withNote({
        flow: { ...flow, step: 'direction', marketId, strikePrice },
        reply: { text: [`Got it — $${num(strikePrice, 0)}. Do you think BTC will settle ABOVE or BELOW that when the market closes?`] },
      });
    }

    case 'direction': {
      const isUp = parseDirection(message);
      if (isUp == null) {
        return withNote({ flow: { ...flow, marketId }, reply: { text: ['Just say “above” (UP) or “below” (DOWN).'] } });
      }
      return withNote({
        flow: { ...flow, step: 'amount', marketId, isUp },
        reply: { text: [`${isUp ? 'Above' : 'Below'} $${num(flow.strikePrice ?? 0, 0)} it is. How much do you want to bet? (in DUSDC, at least ${minStake()})`] },
      });
    }

    case 'amount': {
      const amount = parseNumber(message);
      if (amount == null) {
        return withNote({ flow: { ...flow, marketId }, reply: { text: ['How much DUSDC do you want to bet? Type an amount, e.g. 10.'] } });
      }
      if (amount < minStake()) {
        return withNote({ flow: { ...flow, marketId }, reply: { text: [`The smallest bet is ${minStake()} DUSDC. Type ${minStake()} or more.`] } });
      }
      const maxLev = maxLeverageFor(flow.strikePrice!, flow.isUp!, market, pricer);
      return withNote({
        flow: { ...flow, step: 'leverage', marketId, amount },
        reply: {
          text: [
            `$${num(amount, 2)} DUSDC. Last thing — your leverage.`,
            `Pick anywhere from 1× up to ${num(maxLev, 1)}× for this strike. Higher leverage pays more, but the bet can be closed early for a loss if the price moves against you. (Type 1 for no leverage.)`,
          ],
        },
      });
    }

    case 'leverage': {
      const raw = parseNumber(message);
      if (raw == null) {
        return withNote({ flow: { ...flow, marketId }, reply: { text: ['Pick a leverage number, e.g. 1 or 2.'] } });
      }
      const maxLev = maxLeverageFor(flow.strikePrice!, flow.isUp!, market, pricer);
      let leverage = raw;
      let capNote: string | null = null;
      if (leverage < 1) leverage = 1;
      if (leverage > maxLev) {
        leverage = maxLev;
        capNote = `That's above the max for this strike, so I capped it at ${num(maxLev, 1)}×.`;
      }
      const res = reviewReply({ strikePrice: flow.strikePrice!, isUp: flow.isUp!, amount: flow.amount!, leverage }, market, pricer, ctx.now);
      if (capNote) res.reply.text = [capNote, ...res.reply.text];
      return withNote(res);
    }

    case 'review':
      // Buttons drive Trade/Edit; a stray message just re-shows the recap.
      return withNote(reviewReply({ strikePrice: flow.strikePrice!, isUp: flow.isUp!, amount: flow.amount!, leverage: flow.leverage! }, market, pricer, ctx.now));
  }
}
