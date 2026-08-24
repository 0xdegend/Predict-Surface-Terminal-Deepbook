import { describe, it, expect } from 'vitest';
import { scanEdges, type EdgeScanMarket } from './edge-scan';
import type { SviFloat } from '@/lib/svi/svi';

/** Deterministic pseudo-random walk (same generator as strike-analysis.test). */
function walk(n: number, start = 64_000, stepPct = 0.0004, seed = 42): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (rand() - 0.5) * 2 * stepPct));
  return out;
}

// A normal BTC-ish smile. Against a CALM walk it over-prices movement, so the
// "stays near" side of far strikes comes out cheap — reliable value candidates.
const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 64_000;
const NOW = 1_000_000_000_000;
const closes = walk(2500);

function mkt(over: Partial<EdgeScanMarket> = {}): EdgeScanMarket {
  return {
    marketId: 'm1',
    expiryMs: NOW + 5 * 60_000, // 5m out
    admissionTickSize: '1000000000', // $1 grid
    pricer: { forward: FORWARD, svi: SVI },
    ...over,
  };
}

describe('scanEdges', () => {
  it('returns value candidates on mintable strikes, ranked by edge', () => {
    const out = scanEdges({ markets: [mkt()], closes, now: NOW });
    expect(out.length).toBeGreaterThan(0);
    // Sorted by edge, descending.
    for (let i = 1; i < out.length; i++) expect(out[i - 1].edgePts).toBeGreaterThanOrEqual(out[i].edgePts);
    for (const c of out) {
      expect(c.netEdgePts).toBeGreaterThanOrEqual(1); // default minNetEdgePts
      expect(c.empirical).toBeGreaterThan(c.implied); // it's the VALUE side
      expect(c.implied).toBeGreaterThanOrEqual(0.04);
      expect(c.implied).toBeLessThanOrEqual(0.96);
      expect(c.evPct).toBeGreaterThan(0); // +EV follows a positive edge
      expect(c.payout).toBeCloseTo(1 / c.implied, 6);
      expect(c.samples).toBeGreaterThan(120);
      expect(Number.isFinite(c.strike)).toBe(true);
      expect(c.strike).toBeGreaterThan(0);
    }
  });

  it('honors the minNetEdgePts filter', () => {
    const strict = scanEdges({ markets: [mkt()], closes, now: NOW, minNetEdgePts: 15 });
    for (const c of strict) expect(c.netEdgePts).toBeGreaterThanOrEqual(15);
    // A higher bar never returns MORE than a lower one.
    const loose = scanEdges({ markets: [mkt()], closes, now: NOW, minNetEdgePts: 2 });
    expect(strict.length).toBeLessThanOrEqual(loose.length);
  });

  it('drops the rows the fee eats, and keeps ranking by what is left', () => {
    // The same market, priced with and without the live fee. Every row that
    // survives the fee must clear the bar on its NET edge, and the board must be
    // ordered by that rather than by the raw disagreement with the surface.
    const free = scanEdges({ markets: [mkt()], closes, now: NOW, minNetEdgePts: 0 });
    const charged = scanEdges({
      markets: [mkt({ feeRates: { notional: 0.02, stake: 0.005 } })],
      closes,
      now: NOW,
      minNetEdgePts: 0,
    });
    expect(charged.length).toBeLessThanOrEqual(free.length);
    for (const c of charged) {
      expect(c.netEdgePts).toBeLessThan(c.edgePts); // the fee always costs something
      expect(c.netPayout).toBeLessThan(c.payout);
      expect(c.evPct).toBeGreaterThan(0); // and a listed row is still +EV after it
    }
    for (let i = 1; i < charged.length; i++) {
      expect(charged[i - 1].netEdgePts).toBeGreaterThanOrEqual(charged[i].netEdgePts);
    }
  });

  it('caps the pool at the limit', () => {
    const out = scanEdges({ markets: [mkt()], closes, now: NOW, minNetEdgePts: 0, limit: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('skips expired markets', () => {
    const expired = scanEdges({ markets: [mkt({ expiryMs: NOW - 1 })], closes, now: NOW });
    expect(expired).toEqual([]);
  });

  it('spans multiple expiries', () => {
    const out = scanEdges({
      markets: [mkt({ marketId: 'a', expiryMs: NOW + 60_000 }), mkt({ marketId: 'b', expiryMs: NOW + 2 * 3_600_000 })],
      closes,
      now: NOW,
      minNetEdgePts: 0,
    });
    const ids = new Set(out.map((c) => c.marketId));
    expect(ids.size).toBeGreaterThan(1);
  });

  it('returns nothing without enough recent history', () => {
    expect(scanEdges({ markets: [mkt()], closes: [64_000, 64_010], now: NOW })).toEqual([]);
    expect(scanEdges({ markets: [mkt()], closes: null, now: NOW })).toEqual([]);
  });
});
