import { describe, it, expect } from 'vitest';
import { respondToIntent, timeLeftLabel, type CopilotContext, type BetCandidate } from './respond';
import type { SviFloat } from '@/lib/svi/svi';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const NOW = 1_700_000_000_000;

function candidate(id: string, minutesOut: number, forward = 65_000): BetCandidate {
  const market = { expiry_market_id: id, expiry: NOW + minutesOut * 60_000, admission_tick_size: '1000000000' } as unknown as V2Market;
  const pricer: LivePricer = { expiryMarketId: id, forward, svi: SVI };
  return { market, pricer };
}

const INSIGHTS: BtcInsights = {
  available: true,
  asOf: NOW,
  spot: 65_000,
  change24hPct: 1.8, // clearly bullish
  oiUsd: 50e9,
  funding: { binancePct: 0.01, avgPct: 0.01 },
  liq24h: { totalUsd: 30e6, longUsd: 8e6, shortUsd: 22e6 }, // shorts hit → up
  maxPain: { strike: 65_500, date: '2026-07-22' },
  sentiment: { value: 62, label: 'Greed' },
};

const ctx = (over: Partial<CopilotContext> = {}): CopilotContext => ({
  insights: INSIGHTS,
  candidates: [candidate('m-soon', 4), candidate('m-hour', 58)],
  now: NOW,
  ...over,
});

describe('respondToIntent — analyze', () => {
  it('returns a plain read and no bet', () => {
    const r = respondToIntent({ kind: 'analyze' }, ctx());
    expect(r.bet).toBeUndefined();
    expect(r.text.length).toBeGreaterThan(1);
    expect(r.text.join(' ')).toMatch(/soonest market/i);
  });

  it('falls back gracefully when insights are unavailable', () => {
    const r = respondToIntent({ kind: 'analyze' }, ctx({ insights: null }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/market data/i);
  });
});

describe('respondToIntent — next market', () => {
  it('returns the soonest market details (time + current price), no bet', () => {
    const r = respondToIntent({ kind: 'next_market' }, ctx());
    expect(r.bet).toBeUndefined();
    const blob = r.text.join(' ');
    expect(blob).toMatch(/next market settles/i);
    expect(blob).toMatch(/65,000/); // current price shown
  });

  it('no live market → honest note', () => {
    const r = respondToIntent({ kind: 'next_market' }, ctx({ candidates: [] }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/no live market/i);
  });
});

describe('respondToIntent — directional bet', () => {
  it('safe UP → strike below forward, high odds, small payout', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx());
    expect(r.bet).toBeDefined();
    const b = r.bet!;
    expect(b.dir).toBe('up');
    expect(b.isUp).toBe(true);
    expect(b.marketId).toBe('m-soon');
    expect(b.strikePrice).toBeLessThan(65_000); // safer UP sits below the price
    expect(b.prob).toBeGreaterThan(0.6);
    expect(b.payoutMult).toBeGreaterThan(1);
    expect(b.payoutMult).toBeLessThan(1.7);
  });

  it('longshot UP → strike above forward, lower odds, bigger payout', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'longshot', horizon: 'soonest' }, ctx());
    const b = r.bet!;
    expect(b.strikePrice).toBeGreaterThan(65_000);
    expect(b.prob).toBeLessThan(0.4);
    expect(b.payoutMult).toBeGreaterThan(2.5);
  });

  it('DOWN bet sets isUp false', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'down', conviction: 'even', horizon: 'soonest' }, ctx());
    expect(r.bet!.isUp).toBe(false);
  });

  it('horizon "hour" picks the ~1h market', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'hour' }, ctx());
    expect(r.bet!.marketId).toBe('m-hour');
  });

  it('bullish context → an UP bet reads as aligned', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx());
    expect(r.text.join(' ')).toMatch(/leaning the same way/i);
  });

  it('no live market → no bet, honest note', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx({ candidates: [] }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/no live market/i);
  });
});

describe('respondToIntent — help', () => {
  it('returns guidance, no bet', () => {
    const r = respondToIntent({ kind: 'help' }, ctx());
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/co-pilot/i);
  });
});

describe('plain language (no trader jargon)', () => {
  const BANNED = ['edge', 'basis point', 'sigma', 'implied vol', 'skew', 'delta', 'gamma', 'tape', 'moneyness', 'theta'];
  it('every reply avoids jargon', () => {
    const replies = [
      respondToIntent({ kind: 'analyze' }, ctx()),
      respondToIntent({ kind: 'next_market' }, ctx()),
      respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx()),
      respondToIntent({ kind: 'directional_bet', dir: 'down', conviction: 'longshot', horizon: 'hour' }, ctx()),
      respondToIntent({ kind: 'help' }, ctx()),
    ];
    for (const r of replies) {
      const blob = r.text.join(' ').toLowerCase();
      for (const w of BANNED) expect(blob, w).not.toContain(w);
    }
  });
});

describe('timeLeftLabel', () => {
  it('reads plainly', () => {
    expect(timeLeftLabel(NOW + 30_000, NOW)).toBe('under a minute');
    expect(timeLeftLabel(NOW + 60_000, NOW)).toBe('about a minute');
    expect(timeLeftLabel(NOW + 4 * 60_000, NOW)).toBe('about 4 minutes');
    expect(timeLeftLabel(NOW + 60 * 60_000, NOW)).toBe('about an hour');
  });
});
