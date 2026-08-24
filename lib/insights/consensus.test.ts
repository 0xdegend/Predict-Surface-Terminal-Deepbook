import { describe, it, expect } from 'vitest';
import { buildConsensus, recentVolProb } from './consensus';

describe('recentVolProb', () => {
  it('is 50% at the money and moves the right way with the required move', () => {
    expect(recentVolProb(0, true)).toBeCloseTo(0.5, 6);
    // A strike above the price (positive z) → UP is less likely, DOWN more likely.
    expect(recentVolProb(1, true)).toBeLessThan(0.5);
    expect(recentVolProb(1, false)).toBeGreaterThan(0.5);
    // Symmetry: up and down are complements.
    expect(recentVolProb(0.7, true) + recentVolProb(0.7, false)).toBeCloseTo(1, 6);
  });
});

describe('buildConsensus', () => {
  it('reads tight agreement as a well-priced bet', () => {
    const c = buildConsensus({ isUp: true, surfaceProb: 0.28, sigmaMove: 0.58, empiricalProb: 0.26 })!;
    expect(c.sources).toHaveLength(3);
    expect(c.agreement).toBe('tight');
    expect(c.low).toBeCloseTo(0.26);
    expect(c.high).toBeLessThan(0.5);
    expect(c.synthesis).toMatch(/well-priced/);
  });

  it('flags a split and names the coolest/warmest read', () => {
    const c = buildConsensus({ isUp: true, surfaceProb: 0.5, sigmaMove: 0, empiricalProb: 0.2 })!;
    // surface .50, recentVol .50, history .20 → spread 30 pts
    expect(c.agreement).toBe('split');
    expect(c.spreadPts).toBeCloseTo(30, 0);
    expect(c.synthesis).toMatch(/gap is the opportunity/);
    expect(c.synthesis).toContain('How often it happened'); // the coolest read
  });

  it('works with two sources and drops to null with fewer', () => {
    const two = buildConsensus({ isUp: true, surfaceProb: 0.4, sigmaMove: 0.3, empiricalProb: null });
    expect(two?.sources).toHaveLength(2);
    expect(buildConsensus({ isUp: true, surfaceProb: 0.4, sigmaMove: null, empiricalProb: null })).toBeNull();
    expect(buildConsensus({ isUp: true, surfaceProb: null, sigmaMove: null, empiricalProb: null })).toBeNull();
  });

  it('clamps probabilities into [0,1]', () => {
    const c = buildConsensus({ isUp: true, surfaceProb: 1.4, sigmaMove: 0, empiricalProb: -0.2 })!;
    c.sources.forEach((s) => {
      expect(s.prob).toBeGreaterThanOrEqual(0);
      expect(s.prob).toBeLessThanOrEqual(1);
    });
  });
});

describe('buildConsensus — what traders paid', () => {
  it('adds our own book as a fourth read, right after the surface', () => {
    const c = buildConsensus({ isUp: true, surfaceProb: 0.62, sigmaMove: 0.3, empiricalProb: 0.58, paidProb: 0.55 })!;
    expect(c.sources.map((s) => s.key)).toEqual(['surface', 'crowd', 'recentVol', 'history']);
    // The screen renders sources[0] as its single Plain bar, so the surface must stay first.
    expect(c.sources[0].key).toBe('surface');
    expect(c.sources[1].prob).toBeCloseTo(0.55, 12);
  });

  it('omits it entirely at a strike nobody has traded, rather than inventing a price', () => {
    const none = buildConsensus({ isUp: true, surfaceProb: 0.62, sigmaMove: 0.3, empiricalProb: 0.58 })!;
    expect(none.sources.map((s) => s.key)).not.toContain('crowd');
    expect(buildConsensus({ isUp: true, surfaceProb: 0.62, sigmaMove: 0.3, empiricalProb: 0.58, paidProb: null })!.sources).toHaveLength(3);
  });

  it('widens the spread when the money disagrees with every model', () => {
    const without = buildConsensus({ isUp: true, surfaceProb: 0.6, sigmaMove: 0.25, empiricalProb: 0.58 })!;
    const withCrowd = buildConsensus({ isUp: true, surfaceProb: 0.6, sigmaMove: 0.25, empiricalProb: 0.58, paidProb: 0.3 })!;
    expect(withCrowd.spreadPts).toBeGreaterThan(without.spreadPts);
    expect(withCrowd.agreement).toBe('split');
  });

  it('can stand as a consensus on its own with only the surface beside it', () => {
    const c = buildConsensus({ isUp: true, surfaceProb: 0.6, sigmaMove: null, empiricalProb: null, paidProb: 0.52 });
    expect(c).not.toBeNull();
    expect(c!.sources.map((s) => s.key)).toEqual(['surface', 'crowd']);
  });

  it('clamps a nonsense paid probability into the scale', () => {
    const c = buildConsensus({ isUp: true, surfaceProb: 0.5, sigmaMove: 0, empiricalProb: 0.5, paidProb: 1.8 })!;
    expect(c.sources.find((s) => s.key === 'crowd')!.prob).toBe(1);
  });
});
