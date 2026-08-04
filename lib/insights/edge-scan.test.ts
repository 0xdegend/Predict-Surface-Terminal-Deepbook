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
      expect(c.edgePts).toBeGreaterThanOrEqual(2); // default minEdgePts
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

  it('honors the minEdgePts filter', () => {
    const strict = scanEdges({ markets: [mkt()], closes, now: NOW, minEdgePts: 15 });
    for (const c of strict) expect(c.edgePts).toBeGreaterThanOrEqual(15);
    // A higher bar never returns MORE than a lower one.
    const loose = scanEdges({ markets: [mkt()], closes, now: NOW, minEdgePts: 2 });
    expect(strict.length).toBeLessThanOrEqual(loose.length);
  });

  it('caps the pool at the limit', () => {
    const out = scanEdges({ markets: [mkt()], closes, now: NOW, minEdgePts: 0, limit: 3 });
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
      minEdgePts: 0,
    });
    const ids = new Set(out.map((c) => c.marketId));
    expect(ids.size).toBeGreaterThan(1);
  });

  it('returns nothing without enough recent history', () => {
    expect(scanEdges({ markets: [mkt()], closes: [64_000, 64_010], now: NOW })).toEqual([]);
    expect(scanEdges({ markets: [mkt()], closes: null, now: NOW })).toEqual([]);
  });
});
