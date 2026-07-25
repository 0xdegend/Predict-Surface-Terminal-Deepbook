/**
 * lib/insights/positioning-read.ts — the plain-language lines the co-pilot speaks
 * about positioning & flow, built by rule from the Positioning payload (Clawby PRO).
 *
 * Same discipline as market-read: no jargon — a first-time trader must follow every
 * line (options "calls/puts" are translated to "up/down bets"). PURE + tested, and
 * shared, so the co-pilot and any other surface describe positioning the same way.
 */
import { compact } from '@/lib/format';
import type { Positioning } from './positioning';

const usd = (v: number) => `$${compact(Math.abs(v))}`;

/** Where the wider crowd is leaning (perps account long/short). */
export function crowdLine(p: Positioning): string | null {
  if (!p.crowd) return null;
  const long = Math.round(p.crowd.longPct);
  const lean = p.crowd.longPct > 55 ? 'leaning long' : p.crowd.longPct < 45 ? 'leaning short' : 'split fairly evenly';
  return `Traders are ${lean} — ${long}% are betting up, ${Math.round(p.crowd.shortPct)}% down.`;
}

/** What the biggest traders are doing, and whether they agree with the crowd. */
export function smartMoneyLine(p: Positioning): string | null {
  if (!p.smartMoney) return null;
  const t = p.smartMoney.topLongPct;
  const lean = t > 55 ? 'lean long' : t < 45 ? 'lean short' : 'are split';
  let extra = '';
  if (p.crowd) {
    const gap = t - p.crowd.longPct;
    extra = Math.abs(gap) >= 6 ? (gap > 0 ? ' — more bullish than the wider crowd' : ' — more bearish than the wider crowd') : ' — roughly in line with the crowd';
  }
  return `The biggest traders ${lean} (${Math.round(t)}% long)${extra}.`;
}

/** Who's in control of recent order flow (taker buy vs sell). */
export function pressureLine(p: Positioning): string | null {
  if (!p.pressure) return null;
  const buy = Math.round(p.pressure.buyPct);
  if (p.pressure.buyPct > 53) return `Buyers are in control right now — ${buy}% of recent volume is buying.`;
  if (p.pressure.buyPct < 47) return `Sellers are in control right now — ${Math.round(p.pressure.sellPct)}% of recent volume is selling.`;
  return `Buying and selling are roughly balanced right now (${buy}% buy).`;
}

/** Whether institutions are adding or trimming, via spot-ETF net flow. */
export function flowLine(p: Positioning): string | null {
  if (!p.etfFlow || Math.abs(p.etfFlow.netUsd) < 1e6) return null;
  const bought = p.etfFlow.netUsd >= 0;
  const top = p.etfFlow.byFund[0];
  const topClause = top ? ` (mostly ${top.ticker})` : '';
  return `Spot ETFs ${bought ? 'bought' : 'sold'} ${usd(p.etfFlow.netUsd)} of BTC on the latest day${topClause} — ${bought ? 'institutional money coming in' : 'institutional money heading out'}.`;
}

/** Where the options market is pinned + which side has more open bets. */
export function optionsPinLine(p: Positioning): string | null {
  const near = p.maxPain[0];
  if (!near) return null;
  const pc = near.putCallRatio;
  const tilt = pc <= 0 ? '' : pc < 0.9 ? ', with more up bets than down open' : pc > 1.1 ? ', with more down bets than up open' : ', with up and down bets fairly even';
  return `The options market is pinned near $${compact(near.maxPainPrice)}${tilt}.`;
}

/** How much options money is on the table + venue dominance. */
export function optionsOiLine(p: Positioning): string | null {
  if (!p.options || p.options.totalOiUsd == null) return null;
  const share = p.options.deribitSharePct;
  const shareClause = share != null ? `, and Deribit holds about ${Math.round(share)}% of it` : '';
  return `There's ${usd(p.options.totalOiUsd)} of BTC options open${shareClause}.`;
}

/** A squeeze-risk note when one side of the crowd is very crowded. */
export function squeezeLine(p: Positioning, fundingPct: number | null): string | null {
  if (!p.crowd) return null;
  if (p.crowd.longPct > 62) {
    const paying = fundingPct != null && fundingPct > 0.01 ? ' and paying to hold it' : '';
    return `A lot of traders are crowded long${paying} — if price slips, those longs can get squeezed out, adding fuel to a drop.`;
  }
  if (p.crowd.shortPct > 62) {
    return `A lot of traders are crowded short — a pop higher can squeeze them, adding fuel to a rally.`;
  }
  return null;
}

/** The full "how's everyone positioned?" answer. */
export function positioningLines(p: Positioning | null, fundingPct: number | null): string[] {
  if (!p || !p.available) return [];
  return [crowdLine(p), smartMoneyLine(p), pressureLine(p), squeezeLine(p, fundingPct)].filter((x): x is string => x != null);
}

/** The "are institutions buying?" answer. */
export function flowLines(p: Positioning | null): string[] {
  if (!p || !p.available) return [];
  return [flowLine(p)].filter((x): x is string => x != null);
}

/** The "what's the options market saying?" answer. */
export function optionsLines(p: Positioning | null): string[] {
  if (!p || !p.available) return [];
  return [optionsPinLine(p), optionsOiLine(p)].filter((x): x is string => x != null);
}
