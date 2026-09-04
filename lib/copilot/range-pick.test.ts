import { describe, it, expect } from 'vitest';
import { bandForTarget, pickRange, shapeOrder, MIN_VALUE_EDGE } from './range-pick';
import { CONVICTION_TARGET, type BetCandidate } from './respond';
import { rangeFair, type SviFloat } from '@/lib/svi/svi';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const NOW = 1_800_000_000_000;
const FORWARD = 65_000;
// A wide surface (about a 5% one-sigma move to expiry), so the bands are hundreds of
// dollars wide on a $1 admission grid and every scanned width lands on a distinct band.
const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };

const cand = (minutesOut = 5, svi: SviFloat = SVI): BetCandidate => ({
  market: {
    expiry_market_id: 'm-soon',
    expiry: NOW + minutesOut * 60_000,
    admission_tick_size: '1000000000',
    tick_size: '1',
    max_admission_leverage: 3_000_000_000,
    base_fee: '0',
  } as unknown as V2Market,
  pricer: { expiryMarketId: 'm-soon', forward: FORWARD, svi } as LivePricer,
});

/** 300 one-minute closes compounding `perBar` a bar (so every 5-bar window moves the
 *  same percentage) with a small wobble. */
const tape = (perBar: number, wobble = 0) =>
  Array.from({ length: 300 }, (_, i) => FORWARD * Math.pow(1 + perBar, i) * (1 + wobble * Math.sin(i * 1.7)));

describe('bandForTarget', () => {
  it('prices the band at the target to stay inside, centred on the median', () => {
    const band = bandForTarget(0.72, FORWARD, SVI, '1000000000');
    expect(band).not.toBeNull();
    expect(band!.lower).toBeLessThan(FORWARD);
    expect(band!.higher).toBeGreaterThan(FORWARD);
    expect(rangeFair(band!.lower, band!.higher, FORWARD, SVI)).toBeCloseTo(0.72, 1);
  });

  it('is null when the grid swallows the band', () => {
    // A $1,000,000 admission grid at $65k: both edges snap to the same tick.
    expect(bandForTarget(0.72, FORWARD, SVI, '1000000000000000')).toBeNull();
  });
});

describe('pickRange', () => {
  it('with no history, offers the plain band at the safe target with no edge', () => {
    const pick = pickRange(cand(), { closes: null, spot: FORWARD, now: NOW });
    expect(pick).not.toBeNull();
    expect(pick!.prob).toBeCloseTo(CONVICTION_TARGET.safe, 1);
    expect(pick!.edge).toBe(0);
    expect(pick!.empirical).toBeNull();
    expect(pick!.lower).toBeLessThan(FORWARD);
    expect(pick!.higher).toBeGreaterThan(FORWARD);
    expect(pick!.marketId).toBe('m-soon');
  });

  it('a calm tape against a wide surface is a value pick: history beat the price', () => {
    // BTC barely moved bar to bar, so it stayed inside every band the surface prices,
    // and the empirical hit rate sits well above the surface's chance.
    const pick = pickRange(cand(), { closes: tape(0.00001), spot: FORWARD, now: NOW });
    expect(pick).not.toBeNull();
    expect(pick!.empirical).not.toBeNull();
    expect(pick!.edge).toBeGreaterThan(MIN_VALUE_EDGE);
    expect(pick!.samples).toBeGreaterThan(100);
  });

  it('a trending tape says the band is overpriced, so no range is offered', () => {
    // A steady 2% a bar is 10% a window, past the widest band this surface prices
    // (about 7.6% either side at the 85% width): history says these bands lose.
    const pick = pickRange(cand(), { closes: tape(0.02), spot: FORWARD, now: NOW });
    expect(pick).toBeNull();
  });

  it('keeps to the tradeable middle and never hands back a near-certain band', () => {
    const pick = pickRange(cand(), { closes: tape(0.00001), spot: FORWARD, now: NOW });
    expect(pick!.prob).toBeGreaterThan(0.1);
    expect(pick!.prob).toBeLessThan(0.9);
  });

  it('is null without a forward to price from', () => {
    const c = cand();
    c.pricer = { ...c.pricer, forward: 0 };
    expect(pickRange(c, { closes: null, spot: null, now: NOW })).toBeNull();
  });
});

describe('shapeOrder', () => {
  it('directional only, when the rules leave ranges out', () => {
    expect(shapeOrder({ binaryEdge: 0, rangeEdge: null, lean: 'range' })).toEqual(['binary']);
  });

  it('range only, when the rules leave direction out (whatever the lean)', () => {
    expect(shapeOrder({ binaryEdge: null, rangeEdge: 0, lean: 'up' })).toEqual(['range']);
  });

  it('nothing, with no pick of either shape', () => {
    expect(shapeOrder({ binaryEdge: null, rangeEdge: null, lean: null })).toEqual([]);
  });

  it('a fairly priced market with a clear lean stays directional', () => {
    expect(shapeOrder({ binaryEdge: 0, rangeEdge: 0, lean: 'up' })).toEqual(['binary']);
    expect(shapeOrder({ binaryEdge: 0, rangeEdge: 0, lean: null })).toEqual(['binary']);
  });

  it('a fairly priced market with no clear direction leads with the range, direction as fallback', () => {
    expect(shapeOrder({ binaryEdge: 0, rangeEdge: 0, lean: 'range' })).toEqual(['range', 'binary']);
  });

  it('a mispriced range is offered even against a lean, and leads when its edge is bigger', () => {
    expect(shapeOrder({ binaryEdge: 0, rangeEdge: 0.08, lean: 'up' })).toEqual(['range', 'binary']);
    expect(shapeOrder({ binaryEdge: 0.1, rangeEdge: 0.08, lean: 'range' })).toEqual(['binary', 'range']);
  });

  it('noise-sized edges do not count as value', () => {
    expect(shapeOrder({ binaryEdge: 0, rangeEdge: MIN_VALUE_EDGE, lean: 'up' })).toEqual(['binary']);
  });
});
