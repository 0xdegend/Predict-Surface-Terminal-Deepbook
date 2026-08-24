/**
 * lib/insights/positioning.ts — the canonical shape + plain-language read of the
 * options/flow positioning behind the surface's odds.
 *
 * Filled by the server route from Clawby PRO (option_max_pain → max-pain + put/call
 * per expiry, option_info → OI + venue dominance, ETF flow, long/short ratio). The
 * `positioningVerdict` is a pure, tested synthesis both the page and (later) the X
 * bot render, so the "why behind the odds" reads the same everywhere.
 *
 * PURE + SERVER-SAFE: no React, no fetch. (The Clawby call itself lives in the
 * server-only clawby-server helper, never here.)
 */
import { compact } from '@/lib/format';

export interface ExpiryPositioning {
  /** 'YYYY-MM-DD'. */
  date: string;
  maxPainPrice: number;
  callOi: number;
  putOi: number;
  /** putOi / callOi — under 1 = call-heavy (more up-bets). 0 when no calls. */
  putCallRatio: number;
}

export interface Positioning {
  available: boolean;
  asOf: number;
  /** Nearest expiries, soonest first. */
  maxPain: ExpiryPositioning[];
  /** Whole-market options snapshot. */
  options: { totalOiUsd: number | null; deribitSharePct: number | null; volume24hUsd: number | null } | null;
  /** Latest daily spot-ETF net flow + the biggest movers. */
  etfFlow: { netUsd: number; asOfDate: string; byFund: { ticker: string; flowUsd: number }[] } | null;
  /** Crowd account positioning (perps). */
  crowd: { longPct: number; shortPct: number } | null;
  /** Recent taker buy vs sell pressure (perps, %). */
  pressure: { buyPct: number; sellPct: number } | null;
  /** The biggest traders' account positioning ("smart money"), %. */
  smartMoney: { topLongPct: number; topShortPct: number } | null;
}

/** Join clauses as "a, b, and c". */
function joinClauses(bits: string[]): string {
  if (bits.length <= 1) return bits.join('');
  return `${bits.slice(0, -1).join(', ')}, and ${bits[bits.length - 1]}`;
}

/**
 * A plain-language "why" for the positioning strip. Descriptive, never advice: it
 * restates what the flow is doing (pin, ETF flow, crowd, funding) and gives a coarse
 * lean word. Null when there's nothing to say (no data). No jargon.
 */
export function positioningVerdict(p: Positioning | null, fundingPct: number | null): string | null {
  if (!p || !p.available) return null;

  const bits: string[] = [];
  const pin = p.maxPain[0]?.maxPainPrice;
  if (pin != null) bits.push(`Options are pinned near $${compact(pin)}`);
  if (p.etfFlow && Math.abs(p.etfFlow.netUsd) >= 1e6) {
    bits.push(`ETFs ${p.etfFlow.netUsd >= 0 ? 'bought' : 'sold'} $${compact(Math.abs(p.etfFlow.netUsd))} lately`);
  }
  if (p.crowd) {
    const fundClause = fundingPct != null ? ` into ${fundingPct >= 0 ? 'positive' : 'negative'} funding` : '';
    bits.push(`the crowd is ${Math.round(p.crowd.longPct)}% long${fundClause}`);
  }
  if (bits.length === 0) return null;

  // Coarse positioning lean, blended from the independent signals. Never a probability.
  let s = 0;
  let w = 0;
  if (p.etfFlow) {
    s += Math.sign(p.etfFlow.netUsd);
    w += 1;
  }
  if (p.crowd) {
    s += (p.crowd.longPct - 50) / 50;
    w += 1;
  }
  if (fundingPct != null) {
    s += Math.sign(fundingPct) * 0.5;
    w += 0.5;
  }
  const lean = w > 0 ? s / w : 0;
  const crowded = (p.crowd?.longPct ?? 0) > 62 || (p.crowd?.shortPct ?? 0) > 62;
  const phrase =
    lean > 0.33
      ? crowded
        ? 'a stretched long lean'
        : 'a mildly bullish lean'
      : lean < -0.33
        ? crowded
          ? 'a stretched short lean'
          : 'a mildly bearish lean'
        : 'a mixed setup';

  return `${joinClauses(bits)}, ${phrase}.`;
}
