import { describe, it, expect } from 'vitest';
import { respondToIntent, type CopilotContext, type BetCandidate } from './respond';
import { parseIntent } from './intents';
import type { SviFloat } from '@/lib/svi/svi';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { Positioning } from '@/lib/insights/positioning';

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
  change24hPct: 1.2,
  oiUsd: 3.8e10,
  funding: { binancePct: 0.008, avgPct: 0.007 },
  liq24h: { totalUsd: 4.1e7, longUsd: 1.6e7, shortUsd: 2.5e7 },
  maxPain: { strike: 64_000, date: '2026-07-25' },
  sentiment: { value: 61, label: 'Greed' },
};

const POS: Positioning = {
  available: true,
  asOf: NOW,
  maxPain: [{ date: '2026-07-26', maxPainPrice: 64_000, callOi: 1467, putOi: 1027, putCallRatio: 0.7 }],
  options: { totalOiUsd: 3.37e10, deribitSharePct: 85, volume24hUsd: 1.2e9 },
  etfFlow: { netUsd: -240_000_000, asOfDate: '2026-07-25', byFund: [{ ticker: 'IBIT', flowUsd: -212_000_000 }] },
  crowd: { longPct: 64.7, shortPct: 35.3 },
  pressure: { buyPct: 40.7, sellPct: 59.3 },
  smartMoney: { topLongPct: 65.9, topShortPct: 34.1 },
};

const ctx = (over: Partial<CopilotContext> = {}): CopilotContext => ({
  insights: INSIGHTS,
  positioning: POS,
  candidates: [candidate('m-soon', 4)],
  now: NOW,
  spot: 64_900,
  ...over,
});

describe('co-pilot — new positioning intents parse', () => {
  it('routes the new questions to the right intents', () => {
    expect(parseIntent("how's everyone positioned?").kind).toBe('positioning');
    expect(parseIntent('is the crowd long or short?').kind).toBe('positioning');
    expect(parseIntent('is buying or selling winning right now?').kind).toBe('positioning');
    expect(parseIntent('what is smart money doing?').kind).toBe('positioning');
    expect(parseIntent('are institutions buying?').kind).toBe('flow');
    expect(parseIntent('what are the etf flows?').kind).toBe('flow');
    expect(parseIntent("what's the options market saying?").kind).toBe('options_market');
    expect(parseIntent('what is the put call ratio?').kind).toBe('options_market');
  });
});

describe('co-pilot — positioning answers', () => {
  it('answers "how is everyone positioned" with crowd + smart money + pressure', () => {
    const blob = respondToIntent({ kind: 'positioning' }, ctx()).text.join(' ');
    expect(blob).toMatch(/betting up/); // crowd
    expect(blob).toMatch(/biggest traders/); // smart money
    expect(blob).toMatch(/Sellers are in control/); // pressure
  });

  it('answers institutional flow', () => {
    expect(respondToIntent({ kind: 'flow' }, ctx()).text.join(' ')).toMatch(/Spot ETFs sold/);
  });

  it('answers the options market', () => {
    expect(respondToIntent({ kind: 'options_market' }, ctx()).text.join(' ')).toMatch(/pinned near \$64/);
  });

  it('enriches "Analyze BTC" with positioning + flow', () => {
    const blob = respondToIntent({ kind: 'analyze' }, ctx()).text.join(' ');
    expect(blob).toMatch(/betting up/); // crowd line
    expect(blob).toMatch(/Spot ETFs/); // ETF line
  });

  it('degrades gracefully without positioning data', () => {
    expect(respondToIntent({ kind: 'positioning' }, ctx({ positioning: null })).text.join(' ')).toMatch(/Give it a moment/);
    // Analyze still works, just without the enrichment.
    const a = respondToIntent({ kind: 'analyze' }, ctx({ positioning: null })).text.join(' ');
    expect(a).not.toMatch(/betting up/);
  });
});
