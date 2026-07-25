import { describe, it, expect } from 'vitest';
import { buildNarrative, pickDriver, type NarrativeFeed } from './narrative';
import type { MarketContext } from './context';
import type { Positioning } from './positioning';

const NOW = 1_700_000_000_000;

function ins(over: Partial<MarketContext> = {}): MarketContext {
  return {
    available: true,
    asOf: NOW,
    spot: 64_900,
    change24hPct: -2.4,
    oiUsd: 3.8e10,
    funding: { binancePct: 0.006, avgPct: 0.005 },
    liq24h: { totalUsd: 1e7, longUsd: 5e6, shortUsd: 5e6 },
    maxPain: { strike: 64_000, date: '2026-07-25' },
    sentiment: { value: 40, label: 'Fear' },
    ...over,
  };
}

function pos(over: Partial<Positioning> = {}): Positioning {
  return {
    available: true,
    asOf: NOW,
    maxPain: [],
    options: null,
    etfFlow: null,
    crowd: null,
    pressure: null,
    smartMoney: null,
    ...over,
  };
}

const chatterFeed: NarrativeFeed = {
  available: true,
  asOf: NOW,
  chatter: {
    sampleCount: 22,
    topics: [
      { label: 'macro and Fed policy', count: 9 },
      { label: 'ETF and institutional flows', count: 6 },
    ],
    moodScore: -0.4,
    mood: 'bearish',
    asOf: NOW,
  },
};

describe('pickDriver — the biggest live driver, in priority order', () => {
  it('a lopsided liquidation cascade wins', () => {
    const d = pickDriver(ins({ liq24h: { totalUsd: 1.2e8, longUsd: 9e7, shortUsd: 3e7 } }), null);
    expect(d).toBe('liquidations');
  });

  it('a large ETF flow wins when liquidations are quiet', () => {
    const d = pickDriver(ins(), pos({ etfFlow: { netUsd: -3e8, asOfDate: '2026-07-25', byFund: [] } }));
    expect(d).toBe('etf_flow');
  });

  it('a funding extreme wins when flows and liquidations are quiet', () => {
    const d = pickDriver(ins({ funding: { binancePct: 0.05, avgPct: 0.05 } }), null);
    expect(d).toBe('funding');
  });

  it('falls back to the plain move, then quiet', () => {
    expect(pickDriver(ins({ change24hPct: -2.4 }), null)).toBe('move');
    expect(pickDriver(ins({ change24hPct: 0.2, funding: { binancePct: 0, avgPct: 0 } }), null)).toBe('quiet');
  });

  it('ignores a big-but-balanced liquidation total (no clear side)', () => {
    // Large total, but longs ≈ shorts → not a one-sided cascade, so it's the move.
    const d = pickDriver(ins({ liq24h: { totalUsd: 1.2e8, longUsd: 6e7, shortUsd: 6e7 } }), null);
    expect(d).toBe('move');
  });
});

describe('buildNarrative — the "why is BTC moving?" read', () => {
  it('leads with the move, names the driver, and always ends with the honest caveat', () => {
    const n = buildNarrative({ feed: chatterFeed, insights: ins(), positioning: null, now: NOW });
    expect(n.available).toBe(true);
    expect(n.source).toBe('rules');
    const blob = n.text.join(' ');
    expect(blob).toMatch(/BTC is down -2\.40% over the last day/); // the move
    expect(n.text[n.text.length - 1]).toMatch(/rarely have one clean cause/); // caveat last
    expect(blob).toMatch(/Not financial advice/);
  });

  it('describes a liquidation cascade in plain language', () => {
    const n = buildNarrative({ feed: null, insights: ins({ liq24h: { totalUsd: 1.2e8, longUsd: 9e7, shortUsd: 3e7 } }), positioning: null, now: NOW });
    expect(n.driver).toBe('liquidations');
    expect(n.text.join(' ')).toMatch(/force-closed/);
  });

  it('surfaces what X is discussing as an aggregate (never a quoted post)', () => {
    const n = buildNarrative({ feed: chatterFeed, insights: ins(), positioning: null, now: NOW });
    const blob = n.text.join(' ');
    expect(blob).toMatch(/loudest chatter is around macro and Fed policy and ETF/);
    expect(blob).toMatch(/leaning nervous/); // bearish mood
    expect(blob).toMatch(/not confirmed news/);
  });

  it('adds a fresh read from the recent tape when it is moving', () => {
    // 16 closes, last well below the 16th-from-last → a recent tick down > 0.3%.
    const closes = [65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 65_000, 64_600];
    const n = buildNarrative({ feed: null, insights: ins(), positioning: null, closes, now: NOW });
    expect(n.text.join(' ')).toMatch(/last few minutes/);
  });

  it('prefers a later LLM read when the feed carries one (the ai seam)', () => {
    const feed: NarrativeFeed = { available: true, asOf: NOW, chatter: null, ai: ['BTC slid on a hawkish Fed headline.'] };
    const n = buildNarrative({ feed, insights: ins(), positioning: null, now: NOW });
    expect(n.source).toBe('ai');
    expect(n.text).toEqual(['BTC slid on a hawkish Fed headline.']);
  });

  it('degrades gracefully with no market data', () => {
    const n = buildNarrative({ feed: null, insights: null, positioning: null, now: NOW });
    expect(n.available).toBe(false);
    expect(n.text.join(' ')).toMatch(/give it a moment/i);
  });
});
