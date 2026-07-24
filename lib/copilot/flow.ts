/**
 * lib/copilot/flow.ts — the co-pilot's GUIDED trade wizard: a small state machine
 * that walks a trader through one bet — strike → up/down → amount → leverage →
 * review — then hands back a complete, mintable suggestion the UI loads into the
 * ticket (the trader still confirms + signs; nothing auto-mints).
 *
 * SLOT-FILLING: the wizard also accepts everything in one breath — "set up my
 * trade, strike 66,000, 2x, 6 dusdc" pre-fills every slot it finds and only asks
 * for what's still missing (here: the direction), then jumps straight to the
 * review. Each step advances to the NEXT EMPTY slot, so already-given values are
 * never re-asked. Any inline value is validated against the SAME chain limits a
 * typed-in one is.
 *
 * Unlike respondToIntent (stateless, one-shot), this is stateful: the screen holds
 * a `TradeFlow` and feeds each reply back through `advanceFlow`. Kept pure (no
 * fetch, no React) so it's unit-tested; all live data (every open market + its
 * pricer, now, and the tape's spot) is passed in via FlowContext.
 *
 * MARKET RUNWAY: the wizard PINS a market with enough time left to finish (these
 * markets can be ~1 minute, far shorter than a multi-step chat), and if the pinned
 * one is about to close it hops to the next one with a heads-up — so a slow setup
 * can't die on an expiring market.
 */
import { toFloat, fromFloat, toQuote, fromQuote } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { leverageSliderMax, quantityForStake, winPayout, MIN_STAKE_BASE } from '@/lib/sui/v2/quote';
import { directionFair } from '@/lib/svi/invert';
import { upFair } from '@/lib/svi/svi';
import { num } from '@/lib/format';
import { NON_DIRECTIONAL } from './intents';
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
  /** Live BTC spot ($) — the SAME feed the top price tape shows, for the "BTC is
   *  around $X now" text. Pricing math still uses each market's `forward`. */
  spot?: number | null;
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

/** The "current BTC price" to SHOW — the tape's spot when we have it, else the
 *  market forward. Display only; the odds math always uses the forward. */
function nowPrice(ctx: FlowContext, pricer: LivePricer): number {
  return ctx.spot ?? pricer.forward;
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

/* ------------------------------ slot filling ----------------------------- */

export interface FlowSlots {
  strikePrice?: number;
  isUp?: boolean;
  amount?: number;
  leverage?: number;
}

/**
 * Pull any trade parameters the trader packed into ONE message ("strike 66,000,
 * 2x, bet 6 dusdc"). Each field is keyword/suffix-anchored so the three numbers
 * never get confused; anything absent is just left for the wizard to ask. These
 * are RAW reads — validation (band, min stake, leverage cap) happens when they're
 * filled in. Direction reuses the same "up isn't always UP" guard as intents, so
 * the "up" in "set up" doesn't read as a side.
 */
export function extractSlots(message: string): FlowSlots {
  const t = message.toLowerCase();
  const slots: FlowSlots = {};

  // Leverage — "2x", "leverage 2", "leverage of 2.5x", "lev 2x".
  const lev =
    t.match(/\b(?:leverage|lev)\s*(?:of|is|=|:|at)?\s*(\d+(?:\.\d+)?)\s*x?/) ??
    t.match(/\b(\d+(?:\.\d+)?)\s*x\b/);
  if (lev) slots.leverage = parseFloat(lev[1]);

  // Amount — "bet amount 6 dusdc", "6 dusdc", "stake 10", "bet 5", "amount of 6".
  const amt =
    t.match(/\b(?:bet amount|bet|amount|stake|wager|risk|size)\s*(?:of|is|=|:)?\s*\$?(\d[\d,]*(?:\.\d+)?)/) ??
    t.match(/\$?(\d[\d,]*(?:\.\d+)?)\s*(?:dusdc|usdc|usd|dollars?)\b/);
  if (amt) slots.amount = parseFloat(amt[1].replace(/,/g, ''));

  // Strike — the keyword may come BEFORE the number ("strike 66,000", "price 66k")
  // or AFTER it ("64,850 as my strike", "66k target"). Try both orders; group 1 is
  // always the number and group 2 the optional "k" in either pattern.
  const strike =
    t.match(/\b(?:strike|price|target|level)\s*(?:of|is|=|:|at)?\s*\$?(\d[\d,]*(?:\.\d+)?)\s*(k)?/) ??
    t.match(/\$?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:as\s+(?:my|the|a)\s+)?(?:strike|price|target|level)\b/);
  if (strike) {
    let n = parseFloat(strike[1].replace(/,/g, ''));
    if (strike[2] === 'k') n *= 1000;
    slots.strikePrice = n;
  }

  // Direction (optional) — strip non-directional "up" phrases first ("set up").
  const dir = parseDirection(t.replace(NON_DIRECTIONAL, ' '));
  if (dir != null) slots.isUp = dir;

  return slots;
}

const minStake = () => fromQuote(MIN_STAKE_BASE);

/** Max leverage the chain admits at this strike + direction — the exact cap the
 *  ticket's leverage slider uses. */
function maxLeverageFor(strikeFloat: number, isUp: boolean, market: V2Market, pricer: LivePricer): number {
  const entryProb = directionFair(strikeFloat, pricer.forward, pricer.svi, isUp);
  return leverageSliderMax(entryProb, toFloat(market.max_admission_leverage));
}

/** Snap + band-check a candidate strike against the market's quotable range. */
type StrikeCheck = { ok: true; strikePrice: number } | { ok: false; kind: 'nan' } | { ok: false; kind: 'far'; snapped: number };
function checkStrike(raw: number | null, market: V2Market, pricer: LivePricer): StrikeCheck {
  if (raw == null) return { ok: false, kind: 'nan' };
  const strikePrice = toFloat(snapStrikeToAdmission(fromFloat(raw), market.admission_tick_size));
  const up = upFair(strikePrice, pricer.forward, pricer.svi);
  if (up <= toFloat(market.min_entry_probability) || up >= toFloat(market.max_entry_probability)) {
    return { ok: false, kind: 'far', snapped: strikePrice };
  }
  return { ok: true, strikePrice };
}

/** The soonest open market with enough runway whose admission band can quote this
 *  strike. Lets an inline strike that's too far for the short pinned market get
 *  honored on a longer one (whose wider variance/band covers it) instead of being
 *  silently dropped. Null when no open market can quote it. */
function marketForStrike(strike: number, ctx: FlowContext): BetCandidate | null {
  for (const c of openSorted(ctx)) {
    if (c.market.expiry - ctx.now < FLOW_RUNWAY_MS) continue;
    if (checkStrike(strike, c.market, c.pricer).ok) return c;
  }
  return null;
}

function checkAmount(raw: number | null): { ok: true; amount: number } | { ok: false; kind: 'nan' | 'small' } {
  if (raw == null) return { ok: false, kind: 'nan' };
  if (raw < minStake()) return { ok: false, kind: 'small' };
  return { ok: true, amount: raw };
}

/* --------------------------- questions & review -------------------------- */

/** The first slot still needing a value, in ask-order; 'review' when all filled. */
function nextStep(f: TradeFlow): FlowStep {
  if (f.strikePrice == null) return 'strike';
  if (f.isUp == null) return 'direction';
  if (f.amount == null) return 'amount';
  if (f.leverage == null) return 'leverage';
  return 'review';
}

/** The question that asks for a given step (already-known slots fill the text). */
function questionFor(step: FlowStep, market: V2Market, pricer: LivePricer, ctx: FlowContext, flow: TradeFlow): string[] {
  switch (step) {
    case 'strike': {
      const price = num(nowPrice(ctx, pricer), 0);
      return [`What price do you want to bet on? BTC is around $${price} now. Type a strike, e.g. ${price}.`];
    }
    case 'direction':
      return [`Do you think BTC will settle ABOVE or BELOW $${num(flow.strikePrice ?? 0, 0)} when the market closes?`];
    case 'amount':
      return [`How much do you want to bet? (in DUSDC, at least ${minStake()})`];
    case 'leverage': {
      const maxLev = maxLeverageFor(flow.strikePrice!, flow.isUp!, market, pricer);
      return [
        'Last thing. Your leverage.',
        `Pick anywhere from 1× up to ${num(maxLev, 1)}× for this strike. Higher leverage pays more, but the bet can be closed early for a loss if the price moves against you. (Type 1 for no leverage.)`,
      ];
    }
    case 'review':
      return []; // review is special (returns the bet card)
  }
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

/** The final review card. Clamps leverage into [1, strike max] — a pre-filled
 *  value may sit outside it — and notes when it had to cap. */
function buildReview(flow: TradeFlow, market: V2Market, pricer: LivePricer, ctx: FlowContext, preface?: string | null): FlowResult {
  const maxLev = maxLeverageFor(flow.strikePrice!, flow.isUp!, market, pricer);
  const requested = flow.leverage!;
  const leverage = Math.min(Math.max(1, requested), maxLev);
  const capNote = requested > maxLev ? `That's above the max for this strike, so I capped it at ${num(maxLev, 1)}×.` : null;
  const f: FilledFlow = { strikePrice: flow.strikePrice!, isUp: flow.isUp!, amount: flow.amount!, leverage };
  const pre = [preface, capNote].filter(Boolean) as string[];
  return {
    flow: { step: 'review', marketId: market.expiry_market_id, ...f },
    reply: {
      text: [...pre, "Here's your trade. Check it over, then tap Trade it to place it (or Edit to change something)."],
      bet: reviewBet(f, market, pricer, ctx.now),
    },
  };
}

/** Advance a (partly) filled flow to its next empty slot — asking that question,
 *  or showing the review when everything's set. `lead` is prepended (an ack of
 *  what was just captured). */
function continueFrom(flow: TradeFlow, market: V2Market, pricer: LivePricer, ctx: FlowContext, lead?: string | null): FlowResult {
  const step = nextStep(flow);
  if (step === 'review') return buildReview(flow, market, pricer, ctx, lead);
  const q = questionFor(step, market, pricer, ctx, flow);
  return { flow: { ...flow, step }, reply: { text: lead ? [lead, ...q] : q } };
}

/* -------------------------------- entry ---------------------------------- */

/** Join captured slots into a plain phrase: "a, b, and c". */
function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Begin the wizard. A `message` with inline params ("strike 66,000, 2x, 6
 *  dusdc") pre-fills those slots and resumes at the first one still missing. */
export function startFlow(ctx: FlowContext, message?: string): FlowResult {
  const { cand } = resolveMarket(ctx, {});
  if (!cand) {
    return { flow: null, reply: { text: ["There's no live market to trade right now. Check back in a moment."] } };
  }
  let { market, pricer } = cand;
  let marketId = market.expiry_market_id;

  // Fill any inline params. Strike: checked against the market's quotable band; if
  // it's too far for the short pinned market we HOP to a longer open market that
  // can quote it (honoring the strike) rather than dropping it. Amount validated.
  // Leverage stored (capped at review); direction as-is. Anything we still can't
  // use is called out in `notes`, so the wizard never silently ignores an input.
  const slots = message ? extractSlots(message) : {};
  let flow: TradeFlow = { step: 'strike', marketId };
  const captured: string[] = [];
  const notes: string[] = [];

  if (slots.strikePrice != null) {
    let c = checkStrike(slots.strikePrice, market, pricer);
    if (!c.ok && c.kind === 'far') {
      const alt = marketForStrike(slots.strikePrice, ctx);
      if (alt) {
        market = alt.market;
        pricer = alt.pricer;
        marketId = market.expiry_market_id;
        flow = { ...flow, marketId };
        c = checkStrike(slots.strikePrice, market, pricer);
        notes.push(`Moved you to the market settling in ${timeLeftLabel(market.expiry, ctx.now)} so $${num(slots.strikePrice, 0)} is in range.`);
      }
    }
    if (c.ok) {
      flow = { ...flow, strikePrice: c.strikePrice };
      captured.push(`strike $${num(c.strikePrice, 0)}`);
    } else {
      notes.push(`$${num(slots.strikePrice, 0)} is too far from the current price to quote right now, so pick one closer to it.`);
    }
  }
  if (slots.isUp != null) {
    flow = { ...flow, isUp: slots.isUp };
    captured.push(slots.isUp ? 'settling ABOVE' : 'settling BELOW');
  }
  if (slots.amount != null) {
    const c = checkAmount(slots.amount);
    if (c.ok) {
      flow = { ...flow, amount: c.amount };
      captured.push(`$${num(c.amount, 2)} DUSDC`);
    } else if (c.kind === 'small') {
      notes.push(`A bet needs to be at least ${minStake()} DUSDC, so I skipped the $${num(slots.amount, 2)} you gave.`);
    }
  }
  if (slots.leverage != null) {
    flow = { ...flow, leverage: slots.leverage };
    captured.push(`${num(slots.leverage, 1)}× leverage`);
  }

  // Nothing usable at all → the normal opening question.
  if (captured.length === 0 && notes.length === 0) {
    const price = num(nowPrice(ctx, pricer), 0);
    return {
      flow: { step: 'strike', marketId },
      reply: {
        text: [
          `Let's build your trade on the market settling in ${timeLeftLabel(market.expiry, ctx.now)}.`,
          `What price do you want to bet on? BTC is around $${price} now. Type a strike, e.g. ${price}.`,
        ],
      },
    };
  }

  // Summarize what we caught (+ any notes about what we couldn't use), then
  // continue to the first missing slot (or straight to the review).
  const leadBits: string[] = [];
  if (captured.length) leadBits.push(`Got your setup, ${humanList(captured)}.`);
  leadBits.push(...notes);
  return continueFrom(flow, market, pricer, ctx, leadBits.join(' '));
}

/** Feed the trader's reply into the active wizard and get the next question (or
 *  the final review). Resolves a live market first, hopping (with a heads-up) if
 *  the pinned one is about to close. */
export function advanceFlow(flow: TradeFlow, message: string, ctx: FlowContext): FlowResult {
  if (CANCEL.test(message.toLowerCase())) {
    return { flow: null, reply: { text: ['Okay, cancelled. No trade set up. Ask me anything else whenever you like.'] } };
  }
  const { cand, switched } = resolveMarket(ctx, flow);
  if (!cand) {
    return { flow: null, reply: { text: ["That market closed and there isn't another open right now. Say “set up a trade” to try again in a moment."] } };
  }
  const { market, pricer } = cand;
  const marketId = market.expiry_market_id;

  // A market hop carries the slots over (they're prices/amounts) but re-prices
  // everything against the fresher market — announce it so the odds make sense.
  const note = switched ? `Heads up. That market was about to close, so I moved you to the next one (it settles in ${timeLeftLabel(market.expiry, ctx.now)}).` : null;
  const withNote = (r: FlowResult): FlowResult => (note ? { ...r, reply: { ...r.reply, text: [note, ...r.reply.text] } } : r);
  const reAsk = (text: string[]): FlowResult => withNote({ flow: { ...flow, marketId }, reply: { text } });

  switch (flow.step) {
    case 'strike': {
      const c = checkStrike(parseNumber(message), market, pricer);
      if (!c.ok) {
        return reAsk([
          c.kind === 'nan'
            ? `I didn't catch a price there. Type a strike like ${num(nowPrice(ctx, pricer), 0)}.`
            : `$${num(c.snapped, 0)} is too far from the current price to trade here. Try something within a few hundred dollars of $${num(nowPrice(ctx, pricer), 0)}.`,
        ]);
      }
      return withNote(continueFrom({ ...flow, marketId, strikePrice: c.strikePrice }, market, pricer, ctx, `Got it, $${num(c.strikePrice, 0)}.`));
    }

    case 'direction': {
      const isUp = parseDirection(message);
      if (isUp == null) return reAsk(['Just say “above” (UP) or “below” (DOWN).']);
      return withNote(continueFrom({ ...flow, marketId, isUp }, market, pricer, ctx, `${isUp ? 'Above' : 'Below'} $${num(flow.strikePrice ?? 0, 0)} it is.`));
    }

    case 'amount': {
      const c = checkAmount(parseNumber(message));
      if (!c.ok) {
        return reAsk([
          c.kind === 'nan'
            ? 'How much DUSDC do you want to bet? Type an amount, e.g. 10.'
            : `The smallest bet is ${minStake()} DUSDC. Type ${minStake()} or more.`,
        ]);
      }
      return withNote(continueFrom({ ...flow, marketId, amount: c.amount }, market, pricer, ctx, `$${num(c.amount, 2)} DUSDC.`));
    }

    case 'leverage': {
      const raw = parseNumber(message);
      if (raw == null) return reAsk(['Pick a leverage number, e.g. 1 or 2.']);
      return withNote(continueFrom({ ...flow, marketId, leverage: Math.max(1, raw) }, market, pricer, ctx));
    }

    case 'review':
      // Buttons drive Trade/Edit; a stray message just re-shows the recap.
      return withNote(buildReview({ ...flow, marketId }, market, pricer, ctx));
  }
}
