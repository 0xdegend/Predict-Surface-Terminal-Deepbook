/**
 * lib/insights/market-read.ts — a plain-language "read" of the market, built by
 * rule from the data we already have (Clawby context + the strike analysis).
 *
 * This is the deterministic stand-in for a future LLM narrative. The seam is the
 * `source` field and the `MarketRead` shape: today `buildMarketRead()` fills it
 * by rule; later an `/api/insights/btc/narrative` route (Anthropic) can produce
 * the SAME shape, and the UI won't change. Because it's rule-built it costs
 * nothing per call, never invents a number, and never predicts a price — it only
 * restates figures that are already on screen, in words.
 *
 * Pure and side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 * Plain language is a hard rule here (see the demo-day plain-language standard):
 * no "edge", no "basis points", no Greek — a first-time trader must follow it.
 */
import { compact, num, signed } from '@/lib/format';
import type { MarketContext } from './context';
import type { StrikeAnalysis } from './strike-analysis';

export type ReadTone = 'up' | 'down' | 'warn' | 'neutral';

export interface ReadLine {
  tone: ReadTone;
  text: string;
}

export interface MarketRead {
  /** How the wider market leans vs the picked bet (or on its own, absent a bet). */
  stance: 'aligned' | 'against' | 'mixed' | 'neutral';
  /** One-line takeaway. */
  headline: string;
  /** The supporting observations, each already plain-language. */
  lines: ReadLine[];
  /** Provenance — 'rules' now, 'ai' once a model writes it. Drives the label. */
  source: 'rules' | 'ai';
}

export interface MarketReadInput {
  ctx: MarketContext | null;
  /** Present only once a binary strike is picked and analyzed. */
  strike: StrikeAnalysis | null;
  isUp: boolean;
  strikePrice: number | null;
  /** The surface's forward — the reference the bet settles against. */
  spot: number | null;
  /** Human time-to-expiry, e.g. "4 min" / "45s". */
  timeLeftLabel?: string;
}

const usd = (v: number) => `$${compact(v)}`;

/**
 * A coarse directional lean in [-1, 1] (– bearish, + bullish), blended from the
 * independent signals in the context. Deliberately soft: this colours the
 * wording ("leaning your way"), it is NOT a trade signal, and nothing downstream
 * treats it as a probability.
 */
function marketLean(ctx: MarketContext): number {
  let lean = 0;
  let weight = 0;

  if (ctx.change24hPct != null) {
    lean += Math.max(-1, Math.min(1, ctx.change24hPct / 2)) * 1; // ±2% ⇒ full weight
    weight += 1;
  }
  if (ctx.sentiment) {
    lean += ((ctx.sentiment.value - 50) / 50) * 0.6;
    weight += 0.6;
  }
  // A short squeeze liquidates shorts and drives price UP, and vice-versa — so
  // the side that got liquidated MORE marks the direction of the recent pressure.
  const { longUsd, shortUsd } = ctx.liq24h;
  if (longUsd != null && shortUsd != null && longUsd + shortUsd > 0) {
    const skew = (shortUsd - longUsd) / (shortUsd + longUsd); // + ⇒ shorts hit ⇒ up
    lean += skew * 0.5;
    weight += 0.5;
  }
  return weight > 0 ? lean / weight : 0;
}

function trendLine(ctx: MarketContext): ReadLine | null {
  const chg = ctx.change24hPct;
  if (chg == null) return null;
  const funding = ctx.funding.binancePct;
  const dir = chg > 0.15 ? 'up' : chg < -0.15 ? 'down' : 'flat';
  const mag = `${signed(chg, 2)}%`;

  if (dir === 'flat') {
    return { tone: 'neutral', text: `BTC is roughly flat over the last 24h (${mag}).` };
  }
  const tone: ReadTone = dir === 'up' ? 'up' : 'down';
  let fundingClause = '';
  if (funding != null) {
    const fundingLong = funding >= 0;
    if (dir === 'up') {
      fundingClause = fundingLong
        ? ' and funding is positive, so leveraged traders are leaning long'
        : ", but funding is negative, so the move isn't crowded with longs";
    } else {
      fundingClause = fundingLong
        ? " even though funding stays positive, so longs haven't given up yet"
        : ' with negative funding, so leverage is leaning short';
    }
  }
  return { tone, text: `BTC is ${dir} ${mag} over the last 24h${fundingClause}.` };
}

function liquidationLine(ctx: MarketContext): ReadLine | null {
  const { longUsd, shortUsd } = ctx.liq24h;
  if (longUsd == null || shortUsd == null || longUsd + shortUsd <= 0) return null;
  if (longUsd > shortUsd * 1.25) {
    return {
      tone: 'down',
      text: `Longs took the bigger hit in the last 24h (${usd(longUsd)} vs ${usd(shortUsd)} liquidated), so the recent squeeze ran downward.`,
    };
  }
  if (shortUsd > longUsd * 1.25) {
    return {
      tone: 'up',
      text: `Shorts took the bigger hit in the last 24h (${usd(shortUsd)} vs ${usd(longUsd)} liquidated), a sign the recent squeeze ran upward.`,
    };
  }
  return {
    tone: 'neutral',
    text: `Long and short liquidations were roughly balanced (${usd(longUsd)} / ${usd(shortUsd)}).`,
  };
}

function sentimentLine(ctx: MarketContext): ReadLine | null {
  const s = ctx.sentiment;
  if (!s) return null;
  const tone: ReadTone = s.value < 45 ? 'down' : s.value > 55 ? 'up' : 'neutral';
  const extra =
    s.value < 25 ? ', the crowd is very cautious' : s.value > 75 ? ', the crowd is very optimistic' : '';
  return { tone, text: `Overall sentiment is in ${s.label.toLowerCase()} (${s.value}/100)${extra}.` };
}

/** The strike sentence — required move, how often it's happened, vs the price. */
function strikeLine(
  strike: StrikeAnalysis,
  isUp: boolean,
  strikePrice: number,
  timeLeftLabel: string,
): ReadLine {
  const dir = isUp ? 'above' : 'below';
  const move = `${signed(strike.requiredMovePct, 2)}%`;
  const pieces = [`This bet wins if BTC is ${dir} $${num(strikePrice, 0)} in ${timeLeftLabel}, a ${move} move`];

  if (strike.empirical) {
    pieces.push(`Moves like that have landed about ${(strike.empirical.prob * 100).toFixed(0)}% of the time lately`);
  }
  if (strike.implied != null) {
    pieces.push(`and the surface is charging ${(strike.implied * 100).toFixed(0)}%`);
  }
  let tone: ReadTone = 'neutral';
  if (strike.edgePts != null) {
    if (strike.edgePts > 3) tone = 'down'; // paying more than history justifies
    else if (strike.edgePts < -3) tone = 'up';
  }
  return { tone, text: `${pieces.join('. ').replace('. and', ', and')}.` };
}

function headlineFor(lean: number, hasBet: boolean, isUp: boolean): { stance: MarketRead['stance']; headline: string } {
  const strong = Math.abs(lean) >= 0.28;
  const bullish = lean > 0;

  if (!hasBet) {
    if (!strong) return { stance: 'neutral', headline: "Right now the overall market is pulling both ways." };
    return bullish
      ? { stance: 'neutral', headline: 'Right now the overall market is leaning up.' }
      : { stance: 'neutral', headline: 'Right now the overall market is leaning down.' };
  }
  if (!strong) return { stance: 'mixed', headline: "The overall market doesn't clearly back either side of this bet." };
  const agrees = bullish === isUp;
  return agrees
    ? { stance: 'aligned', headline: 'The overall market is leaning the same way as your bet.' }
    : { stance: 'against', headline: 'The overall market is leaning against your bet.' };
}

/**
 * How the wider market leans relative to a chosen direction — the co-pilot uses
 * this to say "the market is leaning your way / against you" for a suggested bet.
 * Reuses the same soft blend + threshold as the headline, so the two never
 * disagree. 'mixed' when there's no clear lean (or no data).
 */
export function directionStance(ctx: MarketContext | null, isUp: boolean): MarketRead['stance'] {
  if (!ctx || !ctx.available) return 'mixed';
  const lean = marketLean(ctx);
  if (Math.abs(lean) < 0.28) return 'mixed';
  return lean > 0 === isUp ? 'aligned' : 'against';
}

/** A soft, non-advice steer: which way the SAME blended lean points — an UP or
 *  DOWN bet when it's clearly leaning, or a RANGE bet when there's no clear
 *  direction (picking a side is a coin-flip, so a band may fit better). Reuses
 *  the headline's 0.28 threshold so the steer never contradicts the read.
 *  `confidence` = how strong that call is. Null when there's no live data. */
export function recommendation(ctx: MarketContext | null): { pick: 'up' | 'down' | 'range'; confidence: 'slight' | 'clear' } | null {
  if (!ctx || !ctx.available) return null;
  const lean = marketLean(ctx);
  const mag = Math.abs(lean);
  if (mag < 0.28) return { pick: 'range', confidence: mag < 0.12 ? 'clear' : 'slight' };
  return { pick: lean > 0 ? 'up' : 'down', confidence: mag >= 0.5 ? 'clear' : 'slight' };
}

export function buildMarketRead(input: MarketReadInput): MarketRead | null {
  const { ctx, strike, isUp, strikePrice, timeLeftLabel } = input;
  if (!ctx || !ctx.available) return null;

  const lines: ReadLine[] = [];
  const hasBet = strike != null && strikePrice != null;

  if (hasBet) {
    // A bet is picked → the read is ABOUT the bet. Just the strike sentence;
    // the general-market lines (trend/liquidations/sentiment) belong to the
    // no-bet "market read" and are dropped here so the view stays focused.
    lines.push(strikeLine(strike, isUp, strikePrice, timeLeftLabel ?? 'the time left'));
  } else {
    // No bet → read the wider market on its own.
    const t = trendLine(ctx);
    if (t) lines.push(t);
    const l = liquidationLine(ctx);
    if (l) lines.push(l);
    const s = sentimentLine(ctx);
    if (s) lines.push(s);
  }

  if (lines.length === 0) return null;

  const { stance, headline } = headlineFor(marketLean(ctx), hasBet, isUp);
  return { stance, headline, lines, source: 'rules' };
}
