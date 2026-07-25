import { describe, it, expect } from 'vitest';
import { respondToIntent, type CopilotContext, type BetCandidate } from './respond';
import { parseIntent } from './intents';
import type { SviFloat } from '@/lib/svi/svi';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { NarrativeFeed } from '@/lib/insights/narrative';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const NOW = 1_700_000_000_000;

function candidate(id: string, minutesOut: number): BetCandidate {
  return {
    market: { expiry_market_id: id, expiry: NOW + minutesOut * 60_000, admission_tick_size: '1000000000' } as unknown as V2Market,
    pricer: { expiryMarketId: id, forward: 65_000, svi: SVI } as LivePricer,
  };
}

const INSIGHTS: BtcInsights = {
  available: true,
  asOf: NOW,
  spot: 64_900,
  change24hPct: -2.4,
  oiUsd: 3.8e10,
  funding: { binancePct: 0.006, avgPct: 0.005 },
  liq24h: { totalUsd: 1.2e8, longUsd: 9e7, shortUsd: 3e7 },
  maxPain: { strike: 64_000, date: '2026-07-25' },
  sentiment: { value: 40, label: 'Fear' },
};

const FEED: NarrativeFeed = {
  available: true,
  asOf: NOW,
  chatter: {
    sampleCount: 20,
    topics: [
      { label: 'macro and Fed policy', count: 8 },
      { label: 'chart levels and technicals', count: 5 },
    ],
    moodScore: -0.35,
    mood: 'bearish',
    asOf: NOW,
  },
};

const ctx = (over: Partial<CopilotContext> = {}): CopilotContext => ({
  insights: INSIGHTS,
  narrative: FEED,
  candidates: [candidate('m-soon', 4)],
  now: NOW,
  spot: 64_900,
  ...over,
});

describe('co-pilot — "why is BTC moving?" parses', () => {
  it('routes causal questions to why_moving', () => {
    expect(parseIntent('why is BTC dumping?').kind).toBe('why_moving');
    expect(parseIntent("what's driving this?").kind).toBe('why_moving');
    expect(parseIntent('why the drop?').kind).toBe('why_moving');
    expect(parseIntent('any news on bitcoin?').kind).toBe('why_moving');
    expect(parseIntent('what caused the move?').kind).toBe('why_moving');
    expect(parseIntent('why is btc up today?').kind).toBe('why_moving');
  });

  it('does NOT swallow a plain market read or unrelated questions', () => {
    expect(parseIntent("what's happening with bitcoin").kind).toBe('analyze');
    expect(parseIntent('analyze BTC').kind).toBe('analyze');
    expect(parseIntent('why is it so volatile').kind).toBe('volatility');
    expect(parseIntent('why is my bet losing').kind).not.toBe('why_moving');
  });
});

describe('co-pilot — "why is BTC moving?" answers', () => {
  it('names the biggest driver + the chatter, and ends with the caveat', () => {
    const blob = respondToIntent({ kind: 'why_moving' }, ctx()).text.join(' ');
    expect(blob).toMatch(/force-closed/); // the liquidation driver
    expect(blob).toMatch(/loudest chatter is around macro and Fed policy/); // chatter aggregate
    expect(blob).toMatch(/not the whole story/); // honest caveat
  });

  it('works from market data alone when chatter is missing', () => {
    const blob = respondToIntent({ kind: 'why_moving' }, ctx({ narrative: null })).text.join(' ');
    expect(blob).toMatch(/force-closed/);
    expect(blob).not.toMatch(/loudest chatter/);
  });

  it('degrades gracefully with no live data', () => {
    const blob = respondToIntent({ kind: 'why_moving' }, ctx({ insights: null, narrative: null })).text.join(' ');
    expect(blob).toMatch(/give it a moment/i);
  });
});
