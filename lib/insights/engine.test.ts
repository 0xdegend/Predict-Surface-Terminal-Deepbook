import { describe, it, expect } from 'vitest';
import {
  buildMarketIntel,
  openExpiries,
  chanceAbove,
  volState,
  analyzeStrikeForMarket,
  type EngineCandidate,
} from './engine';
import { recommendation } from './market-read';
import type { MarketContext } from './context';
import { DEFAULT_ASSET } from './assets';
import { upFair, type SviFloat } from '@/lib/svi/svi';
// The co-pilot's pulse — the engine must agree with it number-for-number.
import { marketUpChance, marketRows, volState as pulseVolState } from '@/lib/copilot/pulse';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const NOW = 1_700_000_000_000;
const PRICER = { forward: 65_000, svi: SVI };

/** Two live expiries, deliberately out of order to prove sorting. */
const CANDS: EngineCandidate[] = [
  { marketId: 'm-late', expiryMs: NOW + 8 * 60_000, pricer: PRICER },
  { marketId: 'm-soon', expiryMs: NOW + 3 * 60_000, pricer: PRICER },
];

/** The same expiries shaped as the co-pilot's BetCandidate, for cross-checks. */
const BET_CANDS = CANDS.map((c) => ({
  market: { expiry_market_id: c.marketId, expiry: c.expiryMs } as unknown as V2Market,
  pricer: { expiryMarketId: c.marketId, forward: c.pricer.forward, svi: c.pricer.svi } as LivePricer,
}));

const CTX: MarketContext = {
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

/** A deterministic, non-flat 1-minute close series (so realized vol > 0). */
function makeCloses(n = 300, start = 64_000): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = p * (1 + 0.0006 * Math.sin(i / 3) + (i % 7 === 0 ? 0.0004 : -0.00005));
    out.push(p);
  }
  return out;
}
const CLOSES = makeCloses();

describe('engine — openExpiries', () => {
  it('returns still-open expiries soonest first, dropping expired ones', () => {
    const withExpired = [...CANDS, { marketId: 'm-dead', expiryMs: NOW - 1000, pricer: PRICER }];
    const open = openExpiries(withExpired, NOW);
    expect(open.map((c) => c.marketId)).toEqual(['m-soon', 'm-late']);
  });

  it('honours the runway floor', () => {
    const open = openExpiries(CANDS, NOW, 5 * 60_000); // 5-min buffer drops m-soon
    expect(open.map((c) => c.marketId)).toEqual(['m-late']);
  });
});

describe('engine — buildMarketIntel', () => {
  it('composes a full snapshot from live inputs', () => {
    const intel = buildMarketIntel({ asset: DEFAULT_ASSET, now: NOW, spot: 64_900, ctx: CTX, candidates: CANDS, closes: CLOSES });
    expect(intel.asset.id).toBe('BTC');
    expect(intel.nextExpiryMs).toBe(NOW + 3 * 60_000);
    expect(intel.expiries.map((e) => e.marketId)).toEqual(['m-soon', 'm-late']);
    intel.expiries.forEach((e) => {
      expect(e.upChance).toBeGreaterThanOrEqual(0);
      expect(e.upChance).toBeLessThanOrEqual(1);
      expect(e.iv).toBeGreaterThan(0);
    });
    expect(intel.expectedMove).not.toBeNull();
    expect(intel.read).not.toBeNull();
  });

  it('falls back to the context spot when the live spot is missing', () => {
    const intel = buildMarketIntel({ asset: DEFAULT_ASSET, now: NOW, spot: null, ctx: CTX, candidates: CANDS });
    expect(intel.spot).toBe(CTX.spot);
  });

  it('degrades cleanly with no candidates or context', () => {
    const intel = buildMarketIntel({ asset: DEFAULT_ASSET, now: NOW, spot: null, ctx: null, candidates: [] });
    expect(intel.expiries).toEqual([]);
    expect(intel.nextExpiryMs).toBeNull();
    expect(intel.expectedMove).toBeNull();
    expect(intel.vol).toBeNull();
    expect(intel.arb).toBeNull();
    expect(intel.bias).toBeNull();
    expect(intel.read).toBeNull();
  });
});

describe('engine — reality check', () => {
  it('binds the implied prob to the surface (spot = forward) and matches upFair', () => {
    const a = analyzeStrikeForMarket({ closes: CLOSES, pricer: PRICER, strike: 65_500, isUp: true, expiryMs: NOW + 3 * 60_000, now: NOW })!;
    expect(a.implied).toBeCloseTo(upFair(65_500, PRICER.forward, PRICER.svi), 10);
  });

  it('returns null without candles', () => {
    expect(analyzeStrikeForMarket({ closes: null, pricer: PRICER, strike: 65_500, isUp: true, expiryMs: NOW + 3 * 60_000, now: NOW })).toBeNull();
  });
});

// The whole point of the engine: it can never disagree with the co-pilot, because
// both bottom out on the same primitives. These lock that in.
describe('engine ⇄ co-pilot parity', () => {
  it('chanceAbove === pulse.marketUpChance', () => {
    expect(chanceAbove(PRICER, 64_900)).toBeCloseTo(marketUpChance(BET_CANDS[0].pricer, 64_900), 12);
  });

  it('per-expiry upChance matches pulse.marketRows', () => {
    const intel = buildMarketIntel({ asset: DEFAULT_ASSET, now: NOW, spot: 64_900, ctx: CTX, candidates: CANDS });
    const rows = marketRows(BET_CANDS, 64_900, NOW);
    const rowsById = new Map(rows.map((r) => [r.marketId, r.upChance]));
    intel.expiries.forEach((e) => {
      expect(e.upChance).toBeCloseTo(rowsById.get(e.marketId)!, 12);
    });
  });

  it('volState === pulse.volState on identical inputs', () => {
    const mine = volState(CANDS, CLOSES, NOW);
    const theirs = pulseVolState(BET_CANDS, CLOSES, NOW);
    expect(mine).toBe(theirs);
    expect(mine).not.toBeNull(); // the fixture is built to yield a real verdict
  });

  it('bias === recommendation(ctx)', () => {
    const intel = buildMarketIntel({ asset: DEFAULT_ASSET, now: NOW, spot: 64_900, ctx: CTX, candidates: CANDS });
    expect(intel.bias).toEqual(recommendation(CTX));
  });
});
