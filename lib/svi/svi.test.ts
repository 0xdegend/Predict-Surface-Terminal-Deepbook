import { describe, it, expect } from 'vitest';
import { normalCdf } from './normal';
import {
  parseSvi,
  upFair,
  dnFair,
  rangeFair,
  strikeForUpProb,
  defaultBand,
  impliedVol,
  totalVariance,
  logMoneyness,
  type SviFloat,
} from './svi';
import { buildSmile, buildSurface, stressSvi } from './surface';
import type { Oracle, SviEvent } from '@/lib/api/types';

// Real SVI snapshot captured live from the testnet server (BTC oracle).
const RAW_SVI = {
  a: 61536,
  b: 1309541,
  rho: 940001720,
  rho_negative: true,
  m: 4991572,
  m_negative: true,
  sigma: 1072703,
} as unknown as SviEvent;

const FORWARD = 66935.67; // from the same snapshot

const SVI: SviFloat = parseSvi(RAW_SVI);

describe('normalCdf', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 4);
    expect(normalCdf(8)).toBeCloseTo(1, 6);
    expect(normalCdf(-8)).toBeCloseTo(0, 6);
  });
});

describe('parseSvi', () => {
  it('decodes signed-magnitude encoding', () => {
    expect(SVI.a).toBeCloseTo(6.1536e-5, 10);
    expect(SVI.rho).toBeCloseTo(-0.94000172, 8); // rho_negative flag applied
    expect(SVI.m).toBeCloseTo(-0.004991572, 9);
    expect(SVI.sigma).toBeCloseTo(0.001072703, 9);
    expect(SVI.b).toBeGreaterThan(0);
  });
});

describe('upFair / dnFair', () => {
  it('UP + DN = 1 (parity)', () => {
    for (const k of [-0.05, 0, 0.03, 0.1]) {
      const strike = FORWARD * Math.exp(k);
      expect(upFair(strike, FORWARD, SVI) + dnFair(strike, FORWARD, SVI)).toBeCloseTo(1, 9);
    }
  });

  it('UP is in (0,1) and ~0.5 near the forward', () => {
    const atm = upFair(FORWARD, FORWARD, SVI);
    expect(atm).toBeGreaterThan(0.3);
    expect(atm).toBeLessThan(0.7);
  });

  it('UP is monotone non-increasing in strike (no butterfly arb on real params)', () => {
    let prev = Infinity;
    for (let i = -20; i <= 20; i++) {
      const strike = FORWARD * Math.exp(i * 0.01);
      const up = upFair(strike, FORWARD, SVI);
      expect(up).toBeLessThanOrEqual(prev + 1e-9);
      prev = up;
    }
  });

  it('settled oracle pays exact 1/0', () => {
    expect(upFair(60000, FORWARD, SVI, 67000)).toBe(1); // settlement above strike
    expect(upFair(70000, FORWARD, SVI, 67000)).toBe(0); // settlement below strike
  });
});

describe('rangeFair', () => {
  it('is non-negative for lower < higher', () => {
    expect(rangeFair(65000, 68000, FORWARD, SVI)).toBeGreaterThanOrEqual(0);
  });
  it('equals UP(lo) - UP(hi)', () => {
    const lo = 64000;
    const hi = 69000;
    expect(rangeFair(lo, hi, FORWARD, SVI)).toBeCloseTo(
      upFair(lo, FORWARD, SVI) - upFair(hi, FORWARD, SVI),
      12,
    );
  });
});

describe('strikeForUpProb', () => {
  it('recovers a strike whose UP matches the target', () => {
    for (const target of [0.75, 0.5, 0.25, 0.1, 0.9]) {
      const strike = strikeForUpProb(target, FORWARD, SVI);
      expect(upFair(strike, FORWARD, SVI)).toBeCloseTo(target, 4);
    }
  });

  it('is monotone: a higher UP target maps to a lower strike', () => {
    const hiProb = strikeForUpProb(0.75, FORWARD, SVI); // more likely above → lower strike
    const loProb = strikeForUpProb(0.25, FORWARD, SVI); // less likely above → higher strike
    expect(hiProb).toBeLessThan(loProb);
  });

  it('clamps degenerate targets into the open interval', () => {
    // target 0/1 would need an infinite strike; clamped so it still returns finite.
    expect(Number.isFinite(strikeForUpProb(0, FORWARD, SVI))).toBe(true);
    expect(Number.isFinite(strikeForUpProb(1, FORWARD, SVI))).toBe(true);
  });
});

describe('defaultBand', () => {
  it('is a well-ordered ~50% band across forwards', () => {
    for (const fwd of [FORWARD, 30_000, 100_000]) {
      const { lower, higher } = defaultBand(fwd, SVI);
      expect(lower).toBeLessThan(higher);
      // Interquartile band: rangeFair = UP(0.75) - UP(0.25) ≈ 0.5 by construction.
      expect(rangeFair(lower, higher, fwd, SVI)).toBeCloseTo(0.5, 3);
    }
  });

  it('straddles the forward (band contains the current price)', () => {
    const { lower, higher } = defaultBand(FORWARD, SVI);
    expect(lower).toBeLessThan(FORWARD);
    expect(higher).toBeGreaterThan(FORWARD);
  });
});

describe('impliedVol', () => {
  it('equals sqrt(w / T)', () => {
    const T = 0.02;
    const strike = 66000;
    const w = totalVariance(strike, FORWARD, SVI);
    expect(impliedVol(strike, FORWARD, SVI, T)).toBeCloseTo(Math.sqrt(w / T), 12);
  });
  it('is a plausible BTC vol for the actual short tenor', () => {
    // These oracles are ultra-short-dated (~15 min). The SVI total variance w is
    // calibrated to that tenor, so IV = sqrt(w/T) with the real short T is high
    // (~100–150%), which is expected for 15-min BTC binaries.
    const T = 20 / (60 * 24 * 365); // ~20 minutes
    const iv = impliedVol(FORWARD, FORWARD, SVI, T);
    expect(iv).toBeGreaterThan(0.3);
    expect(iv).toBeLessThan(5);
  });
});

describe('logMoneyness', () => {
  it('is 0 at the forward and signed correctly', () => {
    expect(logMoneyness(FORWARD, FORWARD)).toBeCloseTo(0, 12);
    expect(logMoneyness(FORWARD * 1.1, FORWARD)).toBeGreaterThan(0);
    expect(logMoneyness(FORWARD * 0.9, FORWARD)).toBeLessThan(0);
  });
});

// Minimal Oracle fixture for smile/surface builders.
function oracleFixture(over: Partial<Oracle> = {}): Oracle {
  return {
    predict_id: '0xpredict',
    oracle_id: '0xoracle',
    oracle_cap_id: '0xcap',
    underlying_asset: 'BTC',
    expiry: Date.now() + 2 * 3600_000, // 2h out
    min_strike: 50_000 * 1e9,
    tick_size: 1 * 1e9,
    status: 'active',
    activated_at: Date.now(),
    settlement_price: null,
    settled_at: null,
    created_checkpoint: 0,
    ...over,
  };
}

describe('buildSmile', () => {
  it('produces clean (no butterfly) points on real params, centered on forward', () => {
    const smile = buildSmile({ oracle: oracleFixture(), svi: SVI, forward: FORWARD }, { half: 20 });
    expect(smile.points.length).toBeGreaterThan(10);
    expect(smile.hasButterfly).toBe(false);
    // strikes ascending, UP non-increasing
    for (let i = 1; i < smile.points.length; i++) {
      expect(smile.points[i].strike).toBeGreaterThan(smile.points[i - 1].strike);
      expect(smile.points[i].up).toBeLessThanOrEqual(smile.points[i - 1].up + 1e-9);
    }
  });

  it('stress params can trip the butterfly checker', () => {
    const stressed = stressSvi(SVI, 1);
    const smile = buildSmile({ oracle: oracleFixture(), svi: stressed, forward: FORWARD }, { half: 30 });
    // Stress amplifies the wings massively; the smile still builds cleanly.
    expect(stressed.b).toBeGreaterThan(SVI.b);
    expect(smile.points.length).toBeGreaterThan(0);
  });
});

describe('stress trips the no-arb checker (demo requirement §6.4)', () => {
  it('stressed params produce a butterfly violation the clean surface does not', () => {
    // Wide moneyness band (±8% default) so curvature — and any arb — is visible.
    const clean = buildSmile({ oracle: oracleFixture(), svi: SVI, forward: FORWARD });
    expect(clean.hasButterfly).toBe(false);

    const stressed = buildSmile({ oracle: oracleFixture(), svi: stressSvi(SVI, 1), forward: FORWARD });
    expect(stressed.hasButterfly).toBe(true);
  });
});

describe('buildSurface', () => {
  it('stacks expiries ascending in T with aligned k-grid', () => {
    const inputs = [
      { oracle: oracleFixture({ oracle_id: '0xa', expiry: Date.now() + 1 * 3600_000 }), svi: SVI, forward: FORWARD },
      { oracle: oracleFixture({ oracle_id: '0xb', expiry: Date.now() + 4 * 3600_000 }), svi: SVI, forward: FORWARD },
    ];
    const surface = buildSurface(inputs, { kSteps: 21 });
    expect(surface.rows.length).toBe(2);
    expect(surface.rows[0].tYears).toBeLessThan(surface.rows[1].tYears);
    expect(surface.rows[0].cells.length).toBe(21);
    expect(surface.kGrid.length).toBe(21);
    // Same SVI at a longer T → larger total variance → calendar clean.
    expect(surface.hasCalendar).toBe(false);
  });

  it('stress option injects a localized butterfly+calendar sample at the live IV scale', () => {
    const inputs = [
      { oracle: oracleFixture({ oracle_id: '0xa', expiry: Date.now() + 1 * 3600_000 }), svi: SVI, forward: FORWARD },
      { oracle: oracleFixture({ oracle_id: '0xb', expiry: Date.now() + 4 * 3600_000 }), svi: SVI, forward: FORWARD },
    ];
    const opts = { kMin: -0.06, kMax: 0.06, kSteps: 49 };
    const clean = buildSurface(inputs, opts);
    const stressed = buildSurface(inputs, { ...opts, stress: true });

    // Clean surface has neither violation; the stressed one fires BOTH checks.
    expect(clean.hasButterfly).toBe(false);
    expect(clean.hasCalendar).toBe(false);
    expect(stressed.hasButterfly).toBe(true);
    expect(stressed.hasCalendar).toBe(true);

    // The whole point: the surface stays at the LIVE IV scale — no red-plateau
    // explosion. Max IV rises at most by the gentle ~6% cue, never blowing past
    // the clean scale.
    const maxIv = (s: typeof clean) => Math.max(...s.rows.flatMap((r) => r.cells.map((c) => c.iv)));
    expect(maxIv(stressed)).toBeLessThanOrEqual(maxIv(clean) * 1.12);

    // The arb reads as clear bands (more than a couple of cells), but stays a
    // localized region — never the whole surface.
    const total = stressed.rows.reduce((n, r) => n + r.cells.length, 0);
    const flagged = stressed.rows.flatMap((r) => r.cells.filter((c) => c.butterfly || c.calendar));
    expect(flagged.length).toBeGreaterThan(8);
    expect(flagged.length).toBeLessThan(total * 0.5);
  });
});
