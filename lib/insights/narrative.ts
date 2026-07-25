/**
 * lib/insights/narrative.ts — the "why is BTC moving?" read.
 *
 * Answers the causal question the co-pilot gets ("why is it dumping?", "what's
 * driving this?", "any news?") by naming the single biggest live driver from the
 * HARD market data, then layering what X is actually talking about. PURE + tested
 * + jargon-free, the same discipline as market-read / positioning-read.
 *
 * Honesty rules are baked in, not optional:
 *  - The "why" leads with hard data (a forced-liquidation cascade, a large ETF
 *    flow, a funding extreme, or just the plain move). It never leads with social
 *    posts, and it always says short-term moves rarely have one clean cause.
 *  - Social chatter is reported ONLY as an aggregate: which topics are being
 *    discussed and a coarse mood tilt. It never quotes a post. X crypto content is
 *    full of fabricated "BREAKING" clickbait, so we never restate a post as fact.
 *
 * The `source: 'rules' | 'ai'` seam: today buildNarrative composes by rule. When a
 * Claude key is dropped in later, the server route fills `NarrativeFeed.ai` with a
 * credibility-weighted summary and buildNarrative prefers it, with no rework here
 * (mirrors the market-read + intents `rules | ai` seams).
 */
import { num, signed, compact } from '@/lib/format';
import type { MarketContext } from './context';
import type { Positioning } from './positioning';

/** A topic the crowd is discussing, with how many sampled posts touched it. */
export interface ChatterTopic {
  label: string;
  count: number;
}

/**
 * What X is talking about right now, as an AGGREGATE only (no quoted posts). Built
 * by the server route from a spam-filtered, author-quality-filtered sample.
 */
export interface NarrativeChatter {
  /** Posts that survived the spam + author-quality filter. */
  sampleCount: number;
  /** Top discussion topics (macro, ETF, regulation, technicals), most-discussed first. */
  topics: ChatterTopic[];
  /** Directional mood of the chatter: >0 leans up, <0 leans down, ~0 mixed. */
  moodScore: number;
  mood: 'bullish' | 'bearish' | 'mixed';
  asOf: number;
}

/**
 * The payload the /api/insights/btc/narrative route returns. Today it carries the
 * chatter aggregate; `ai` is the seam a later Claude slice fills server-side, which
 * buildNarrative prefers over its own rule-based text when present.
 */
export interface NarrativeFeed {
  available: boolean;
  asOf: number;
  chatter: NarrativeChatter | null;
  /** Filled ONLY by the future LLM slice (server-side). Unused by the rule path. */
  ai?: string[];
}

export type NarrativeSource = 'rules' | 'ai';

/** The single biggest thing moving price, in priority order of how mechanical it is. */
export type DriverKind = 'liquidations' | 'etf_flow' | 'funding' | 'move' | 'quiet';

export interface Narrative {
  available: boolean;
  source: NarrativeSource;
  asOf: number;
  /** The composed plain-language answer, line by line. */
  text: string[];
  /** The driver we identified (for the UI / tests). Null on the AI path or no data. */
  driver: DriverKind | null;
  chatter: NarrativeChatter | null;
}

const usd = (v: number) => `$${compact(Math.abs(v))}`;

function moveWord(chg: number): string {
  return chg >= 0.05 ? 'up' : chg <= -0.05 ? 'down' : 'flat';
}

/**
 * Pick the single biggest live driver from the hard data. Ordered by how directly
 * each one MECHANICALLY moves short-term price: a forced-liquidation cascade first
 * (it feeds on itself intrabar), then a large daily ETF flow, then a funding
 * extreme (crowded positioning), then the plain move, else quiet.
 */
export function pickDriver(ins: MarketContext, pos: Positioning | null): DriverKind {
  const chg = ins.change24hPct ?? 0;
  const liq = ins.liq24h;
  const etf = pos?.etfFlow?.netUsd ?? null;
  const funding = ins.funding.binancePct ?? ins.funding.avgPct ?? null;

  const bigLiq =
    liq.totalUsd != null &&
    liq.totalUsd >= 5e7 &&
    liq.longUsd != null &&
    liq.shortUsd != null &&
    (liq.longUsd > liq.shortUsd * 1.4 || liq.shortUsd > liq.longUsd * 1.4);
  if (bigLiq) return 'liquidations';
  if (etf != null && Math.abs(etf) >= 2e8) return 'etf_flow';
  if (funding != null && Math.abs(funding) >= 0.03) return 'funding';
  if (Math.abs(chg) >= 1.2) return 'move';
  return 'quiet';
}

/** The plain-language sentence for the chosen driver. */
function driverLine(driver: DriverKind, ins: MarketContext, pos: Positioning | null): string {
  const chg = ins.change24hPct ?? 0;
  switch (driver) {
    case 'liquidations': {
      const { totalUsd, longUsd, shortUsd } = ins.liq24h;
      const longHit = (longUsd ?? 0) > (shortUsd ?? 0);
      return `The main driver looks mechanical. About ${usd(totalUsd ?? 0)} of positions were force-closed in the last day, mostly traders who bet ${longHit ? 'up' : 'down'}. That kind of forced ${longHit ? 'selling can speed up a drop' : 'buying can push price up fast'}.`;
    }
    case 'etf_flow': {
      const net = pos?.etfFlow?.netUsd ?? 0;
      const bought = net >= 0;
      return `The biggest driver is institutional money. Spot ETFs ${bought ? 'bought' : 'sold'} about ${usd(net)} of BTC on the latest day, which ${bought ? 'adds steady buying pressure' : 'pulls steady buying away'}.`;
    }
    case 'funding': {
      const f = ins.funding.binancePct ?? ins.funding.avgPct ?? 0;
      const long = f > 0;
      return `The crowd is leaning hard ${long ? 'up' : 'down'} (funding is ${signed(f, 3)}%), so the move is being driven more by ${long ? 'over-eager up bets' : 'over-eager down bets'} than fresh news, and that can reverse quickly.`;
    }
    case 'move': {
      const dir = chg >= 0 ? 'up' : 'down';
      return `There's no single dramatic cause in the data. BTC is ${dir} ${signed(chg, 2)}% on the day, which is inside its normal back-and-forth.`;
    }
    case 'quiet':
      return `Honestly, not much is happening. BTC is roughly flat on the day (${signed(chg, 2)}%), so there's no real story to point at right now.`;
  }
}

/** "what people are discussing", from the aggregate chatter (never a quoted post). */
function chatterLine(chatter: NarrativeChatter): string | null {
  if (chatter.sampleCount === 0) return null;
  const topics = chatter.topics.slice(0, 2).map((t) => t.label);
  const topicPhrase = topics.length ? topics.join(' and ') : 'general price talk';
  const moodPhrase =
    chatter.mood === 'bearish'
      ? 'the mood is leaning nervous'
      : chatter.mood === 'bullish'
        ? 'the mood is leaning hopeful'
        : 'the mood is split';
  return `On X, the loudest chatter is around ${topicPhrase}, and ${moodPhrase}. That's what people are discussing, not confirmed news.`;
}

/**
 * Compose the "why is BTC moving?" answer. Prefers the LLM read when the feed
 * carries one; otherwise builds the rule-based read: the move, the biggest driver,
 * what X is discussing, and an honest caveat.
 */
export function buildNarrative(input: {
  feed: NarrativeFeed | null;
  insights: MarketContext | null;
  positioning: Positioning | null;
  closes?: number[] | null;
  now: number;
}): Narrative {
  const { feed, insights: ins, positioning: pos, closes, now } = input;

  // AI seam: a later server-side Claude slice fills feed.ai. Prefer it verbatim.
  if (feed?.ai && feed.ai.length > 0) {
    return { available: true, source: 'ai', asOf: feed.asOf, text: feed.ai, driver: null, chatter: feed.chatter ?? null };
  }

  if (!ins || !ins.available) {
    return {
      available: false,
      source: 'rules',
      asOf: now,
      text: ["I can't read the live market right now, so I can't tell you what's moving it. Give it a moment and ask again."],
      driver: null,
      chatter: feed?.chatter ?? null,
    };
  }

  const chg = ins.change24hPct ?? 0;
  const text: string[] = [];

  // 1) The move itself.
  const where = ins.spot != null ? `, around $${num(ins.spot, 0)}` : '';
  text.push(`BTC is ${moveWord(chg)} ${signed(chg, 2)}% over the last day${where}.`);

  // 1b) A fresher read from the recent 1-minute tape, when it's actually moving.
  if (closes && closes.length >= 16) {
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 16];
    if (last > 0 && prev > 0) {
      const recent = ((last - prev) / prev) * 100;
      if (Math.abs(recent) >= 0.3) {
        text.push(`In just the last few minutes it's ${recent >= 0 ? 'ticked up' : 'ticked down'} about ${signed(recent, 2)}%.`);
      }
    }
  }

  // 2) The single biggest driver, from the hard data.
  const driver = pickDriver(ins, pos);
  text.push(driverLine(driver, ins, pos));

  // 3) What X is discussing (aggregate only).
  const chatter = feed?.chatter ?? null;
  if (chatter) {
    const line = chatterLine(chatter);
    if (line) text.push(line);
  }

  // 4) Honest caveat. Always.
  text.push('Short-term moves rarely have one clean cause, so treat this as the most likely driver from the data, not the whole story. Not financial advice.');

  return { available: true, source: 'rules', asOf: feed?.asOf ?? now, text, driver, chatter };
}
