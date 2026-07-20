import { describe, it, expect } from 'vitest';
import { analyzeStrike, empiricalHitRate, realizedVol, strikeVerdict } from './strike-analysis';

/** Deterministic pseudo-random walk so the stats below are reproducible. */
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

describe('realizedVol', () => {
  it('is zero for a flat series', () => {
    expect(realizedVol(Array(100).fill(64_000))).toBe(0);
  });

  it('grows with the size of the steps', () => {
    expect(realizedVol(walk(500, 64_000, 0.001))).toBeGreaterThan(realizedVol(walk(500, 64_000, 0.0002)));
  });

  it('degrades to 0 rather than NaN on too-short input', () => {
    expect(realizedVol([64_000])).toBe(0);
    expect(realizedVol([])).toBe(0);
  });
});

describe('empiricalHitRate', () => {
  it('returns null when there are too few windows to mean anything', () => {
    expect(empiricalHitRate(walk(50), 5, 0, true)).toBeNull();
    // Horizon so long it eats the sample.
    expect(empiricalHitRate(walk(200), 150, 0, true)).toBeNull();
  });

  it('is ~50/50 at the money on a driftless walk', () => {
    const r = empiricalHitRate(walk(2000), 5, 0, true);
    expect(r).not.toBeNull();
    expect(r!.prob).toBeGreaterThan(0.35);
    expect(r!.prob).toBeLessThan(0.65);
  });

  it('falls as the required move gets further away', () => {
    const c = walk(2000);
    const near = empiricalHitRate(c, 10, 0.0005, true)!.prob;
    const far = empiricalHitRate(c, 10, 0.01, true)!.prob;
    expect(far).toBeLessThan(near);
  });

  it('is TERMINAL, not touch — a spike through that comes back is a loss', () => {
    // 300 flat bars, then one bar spikes +5% and immediately returns.
    const closes = Array(300).fill(100);
    closes[150] = 105;
    // Needing +1% over a 2-bar window: only windows ENDING on the spike win.
    const r = empiricalHitRate(closes, 2, 0.01, true)!;
    expect(r.prob).toBeLessThan(0.02);
  });

  it('up and down are complements away from exact ties', () => {
    const c = walk(2000);
    const up = empiricalHitRate(c, 5, 0.002, true)!.prob;
    const down = empiricalHitRate(c, 5, 0.002, false)!.prob;
    expect(up + down).toBeCloseTo(1, 1);
  });
});

describe('analyzeStrike', () => {
  const closes = walk(2000);

  it('reports the required move with the right sign', () => {
    const up = analyzeStrike({ closes, spot: 64_000, strike: 64_640, isUp: true, minutesToExpiry: 5 })!;
    expect(up.requiredMovePct).toBeCloseTo(1, 6);
    expect(up.requiredMoveUsd).toBeCloseTo(640, 6);

    const down = analyzeStrike({ closes, spot: 64_000, strike: 63_360, isUp: false, minutesToExpiry: 5 })!;
    expect(down.requiredMovePct).toBeCloseTo(-1, 6);
  });

  it('scales sigmaMove down as more time is allowed', () => {
    const short = analyzeStrike({ closes, spot: 64_000, strike: 64_200, isUp: true, minutesToExpiry: 1 })!;
    const long = analyzeStrike({ closes, spot: 64_000, strike: 64_200, isUp: true, minutesToExpiry: 30 })!;
    expect(Math.abs(long.sigmaMove)).toBeLessThan(Math.abs(short.sigmaMove));
  });

  it('computes edge in probability points, surface minus history', () => {
    const a = analyzeStrike({
      closes,
      spot: 64_000,
      strike: 64_000,
      isUp: true,
      minutesToExpiry: 5,
      impliedProb: 0.9, // absurdly rich vs a driftless walk
    })!;
    expect(a.edgePts).not.toBeNull();
    expect(a.edgePts!).toBeGreaterThan(20);
    expect(strikeVerdict(a).tone).toBe('rich');
  });

  it('leaves edge null when the surface price is unknown', () => {
    const a = analyzeStrike({ closes, spot: 64_000, strike: 64_000, isUp: true, minutesToExpiry: 5 })!;
    expect(a.implied).toBeNull();
    expect(a.edgePts).toBeNull();
    expect(strikeVerdict(a).tone).toBe('none');
  });

  it('guards against junk inputs instead of returning NaN', () => {
    expect(analyzeStrike({ closes, spot: 0, strike: 64_000, isUp: true, minutesToExpiry: 5 })).toBeNull();
    expect(analyzeStrike({ closes: [], spot: 64_000, strike: 64_000, isUp: true, minutesToExpiry: 5 })).toBeNull();
  });

  it('does not divide by zero at expiry', () => {
    const a = analyzeStrike({ closes, spot: 64_000, strike: 64_100, isUp: true, minutesToExpiry: 0 })!;
    expect(Number.isFinite(a.sigmaMove)).toBe(true);
  });
});
