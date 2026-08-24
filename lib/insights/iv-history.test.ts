import { describe, it, expect } from 'vitest';
import {
  constantMaturityAtmIv,
  ivBand,
  ivRank,
  CONSTANT_TENOR_YEARS,
  MIN_RANK_SAMPLES,
  MIN_RANK_SPAN_MS,
  type AtmPoint,
  type IvSample,
} from './iv-history';

const YEAR_MS = 365 * 24 * 3_600_000;
const yearsOf = (ms: number) => ms / YEAR_MS;

describe('constantMaturityAtmIv', () => {
  it('returns null with nothing usable', () => {
    expect(constantMaturityAtmIv([])).toBeNull();
    expect(constantMaturityAtmIv([{ tYears: 0, atmIv: 0.5 }])).toBeNull();
    expect(constantMaturityAtmIv([{ tYears: 1, atmIv: 0 }])).toBeNull();
  });

  it('passes a single expiry straight through', () => {
    expect(constantMaturityAtmIv([{ tYears: yearsOf(3_600_000), atmIv: 0.7 }])).toBeCloseTo(0.7);
  });

  it('reproduces a flat term structure exactly', () => {
    const pts: AtmPoint[] = [
      { tYears: yearsOf(10 * 60_000), atmIv: 0.6 },
      { tYears: yearsOf(4 * 3_600_000), atmIv: 0.6 },
    ];
    expect(constantMaturityAtmIv(pts)).toBeCloseTo(0.6, 6);
  });

  it('interpolates between bracketing expiries', () => {
    const pts: AtmPoint[] = [
      { tYears: yearsOf(30 * 60_000), atmIv: 0.5 },
      { tYears: yearsOf(2 * 3_600_000), atmIv: 0.9 },
    ];
    const iv = constantMaturityAtmIv(pts)!;
    expect(iv).toBeGreaterThan(0.5);
    expect(iv).toBeLessThan(0.9);
  });

  it('interpolates in total variance, not in vol', () => {
    // Two points whose midpoint in T differs between the two conventions.
    const t1 = yearsOf(30 * 60_000);
    const t2 = yearsOf(90 * 60_000);
    const pts: AtmPoint[] = [
      { tYears: t1, atmIv: 0.4 },
      { tYears: t2, atmIv: 1.0 },
    ];
    const target = CONSTANT_TENOR_YEARS; // 60 min, exactly halfway
    const got = constantMaturityAtmIv(pts, target)!;

    const w1 = 0.4 * 0.4 * t1;
    const w2 = 1.0 * 1.0 * t2;
    const expected = Math.sqrt((w1 + (w2 - w1) * 0.5) / target);
    expect(got).toBeCloseTo(expected, 9);

    // And it is NOT the naive linear-in-vol answer.
    expect(got).not.toBeCloseTo(0.7, 3);
  });

  it('holds vol flat outside the live range rather than extrapolating variance', () => {
    const shortOnly: AtmPoint[] = [
      { tYears: yearsOf(60_000), atmIv: 0.8 },
      { tYears: yearsOf(5 * 60_000), atmIv: 0.75 },
    ];
    // Target (1h) is beyond the longest expiry, so it clamps to the far end.
    expect(constantMaturityAtmIv(shortOnly)).toBeCloseTo(0.75);

    const longOnly: AtmPoint[] = [
      { tYears: yearsOf(6 * 3_600_000), atmIv: 0.55 },
      { tYears: yearsOf(24 * 3_600_000), atmIv: 0.6 },
    ];
    expect(constantMaturityAtmIv(longOnly)).toBeCloseTo(0.55);
  });

  it('does not care what order the expiries arrive in', () => {
    const a = constantMaturityAtmIv([
      { tYears: yearsOf(2 * 3_600_000), atmIv: 0.9 },
      { tYears: yearsOf(30 * 60_000), atmIv: 0.5 },
    ]);
    const b = constantMaturityAtmIv([
      { tYears: yearsOf(30 * 60_000), atmIv: 0.5 },
      { tYears: yearsOf(2 * 3_600_000), atmIv: 0.9 },
    ]);
    expect(a).toBeCloseTo(b!, 9);
  });
});

describe('ivBand', () => {
  it('maps percentiles to bands', () => {
    expect(ivBand(0.02)).toBe('unusually calm');
    expect(ivBand(0.2)).toBe('calm');
    expect(ivBand(0.5)).toBe('normal');
    expect(ivBand(0.8)).toBe('busy');
    expect(ivBand(0.97)).toBe('unusually busy');
  });
});

describe('ivRank', () => {
  /** `n` samples, `stepMs` apart, ivs cycling through `values`. */
  const series = (values: number[], stepMs = 5 * 60_000, startMs = 1_700_000_000_000): IvSample[] =>
    values.map((iv, i) => ({ tMs: startMs + i * stepMs, iv }));

  const flat = (n: number, iv = 0.6) => series(Array.from({ length: n }, () => iv));
  const spread = (n: number) => series(Array.from({ length: n }, (_, i) => 0.4 + (i / n) * 0.4));

  it('is null before there are enough samples', () => {
    expect(ivRank(flat(MIN_RANK_SAMPLES - 1), 0.6)).toBeNull();
  });

  it('is null when the samples are dense but the span is short', () => {
    // Plenty of readings, all inside a couple of minutes.
    const dense = series(Array.from({ length: 40 }, () => 0.6), 2_000);
    expect(dense[dense.length - 1].tMs - dense[0].tMs).toBeLessThan(MIN_RANK_SPAN_MS);
    expect(ivRank(dense, 0.6)).toBeNull();
  });

  it('is null for a non-positive reading', () => {
    expect(ivRank(spread(40), 0)).toBeNull();
  });

  it('reports the observed range and median', () => {
    const r = ivRank(spread(40), 0.6)!;
    expect(r.low).toBeCloseTo(0.4);
    expect(r.high).toBeLessThan(0.8);
    expect(r.median).toBeGreaterThan(r.low);
    expect(r.samples).toBe(40);
  });

  it('puts a reading above everything at the top of the range', () => {
    const r = ivRank(spread(40), 5)!;
    expect(r.percentile).toBe(1);
    expect(r.band).toBe('unusually busy');
  });

  it('puts a reading below everything at the bottom', () => {
    const r = ivRank(spread(40), 0.01)!;
    expect(r.percentile).toBe(0);
    expect(r.band).toBe('unusually calm');
  });

  it('lands mid-range for a mid-range reading', () => {
    const r = ivRank(spread(40), 0.6)!;
    expect(r.percentile).toBeGreaterThan(0.4);
    expect(r.percentile).toBeLessThan(0.6);
    expect(r.band).toBe('normal');
  });

  it('drops junk samples rather than letting them skew the range', () => {
    const withJunk: IvSample[] = [
      ...spread(40),
      { tMs: 1_700_000_000_000, iv: Number.NaN },
      { tMs: Number.NaN, iv: 0.5 },
      { tMs: 1_700_000_000_000, iv: -1 },
    ];
    const r = ivRank(withJunk, 0.6)!;
    expect(r.samples).toBe(40);
    expect(Number.isFinite(r.low)).toBe(true);
  });

  it('writes a summary that names the level and the window', () => {
    const r = ivRank(spread(40), 0.6)!;
    expect(r.summary).toContain('60%');
    expect(r.summary).toMatch(/minutes|hours|days/);
  });

  it('calls out an extreme explicitly', () => {
    expect(ivRank(spread(40), 5)!.summary).toContain('long way from normal');
    expect(ivRank(spread(40), 0.6)!.summary).not.toContain('long way from normal');
  });

  it('is unaffected by the order samples arrive in', () => {
    const asc = spread(40);
    const shuffled = [...asc].reverse();
    expect(ivRank(shuffled, 0.6)!.percentile).toBeCloseTo(ivRank(asc, 0.6)!.percentile);
  });
});
