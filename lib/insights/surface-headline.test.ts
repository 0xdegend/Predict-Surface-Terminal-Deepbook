import { describe, it, expect } from 'vitest';
import {
  buildSurfaceHeadline,
  dearSide,
  RR_FLAT_PTS,
  RR_STRONG_PTS,
  type SurfaceHeadlineInput,
} from './surface-headline';
import type { ExpectedMove } from './expected-move';
import type { SurfaceShape } from './surface-shape';

const EM: ExpectedMove = { forward: 80_000, sigma: 0.01, lowPrice: 79_200, highPrice: 80_800 };

const shape = (rr25Pts: number): SurfaceShape => ({
  callIv: 0.6 + rr25Pts / 200,
  putIv: 0.6 - rr25Pts / 200,
  rr25Pts,
  callStrike: 81_000,
  putStrike: 79_000,
});

const input = (over: Partial<SurfaceHeadlineInput> = {}): SurfaceHeadlineInput => ({
  asset: 'BTC',
  em: EM,
  horizon: '1 hour',
  shape: shape(0),
  atmIv: 0.62,
  ivBand: null,
  term: null,
  basisPct: null,
  ...over,
});

describe('dearSide', () => {
  it('is null inside the flat band', () => {
    expect(dearSide(0)).toBeNull();
    expect(dearSide(RR_FLAT_PTS - 0.01)).toBeNull();
    expect(dearSide(-(RR_FLAT_PTS - 0.01))).toBeNull();
  });

  it('reads negative risk reversal as downside being dear', () => {
    expect(dearSide(-5)).toBe('downside');
  });

  it('reads positive as upside', () => {
    expect(dearSide(5)).toBe('upside');
  });

  it('is null for a missing or broken reading', () => {
    expect(dearSide(null)).toBeNull();
    expect(dearSide(undefined)).toBeNull();
    expect(dearSide(Number.NaN)).toBeNull();
  });
});

describe('buildSurfaceHeadline', () => {
  it('is null without an expected move, rather than a headline with no number', () => {
    expect(buildSurfaceHeadline(input({ em: null }))).toBeNull();
  });

  it('is null for a degenerate move', () => {
    expect(buildSurfaceHeadline(input({ em: { ...EM, sigma: 0 } }))).toBeNull();
    expect(buildSurfaceHeadline(input({ em: { ...EM, forward: 0 } }))).toBeNull();
  });

  it('leads with the dollar move and the horizon', () => {
    const h = buildSurfaceHeadline(input())!;
    expect(h.text).toContain('BTC is priced to move about $800');
    expect(h.text).toContain('in the next 1 hour');
  });

  it('drops the horizon clause when there is none', () => {
    const h = buildSurfaceHeadline(input({ horizon: null }))!;
    expect(h.text).toContain('either way.');
    expect(h.text).not.toContain('in the next');
  });

  it('calls both sides even inside the flat band', () => {
    const h = buildSurfaceHeadline(input({ shape: shape(0) }))!;
    expect(h.text).toContain('Both sides are priced about the same');
    expect(h.tone).toBe('neutral');
  });

  it('names the dear side and colours the tone with it', () => {
    const down = buildSurfaceHeadline(input({ shape: shape(-3) }))!;
    expect(down.text).toContain('paying up for downside protection');
    expect(down.tone).toBe('down');

    const up = buildSurfaceHeadline(input({ shape: shape(3) }))!;
    expect(up.text).toContain('paying up for upside protection');
    expect(up.tone).toBe('up');
  });

  it('escalates the wording for a pronounced skew', () => {
    const h = buildSurfaceHeadline(input({ shape: shape(-(RR_STRONG_PTS + 1)) }))!;
    expect(h.text).toContain('paying well up');
  });

  it('never states a direction, only what pricing is dear', () => {
    for (const rr of [-8, -3, 0, 3, 8]) {
      const h = buildSurfaceHeadline(input({ shape: shape(rr) }))!;
      expect(h.text).not.toMatch(/likely to (rise|fall)|going (up|down)|expects? (a )?(rally|drop)/i);
    }
  });

  it('opens the detail with the range', () => {
    const h = buildSurfaceHeadline(input())!;
    expect(h.detail[0]).toContain('$79,200 to $80,800');
  });

  it('adds the vol level, and names the band when history knows one', () => {
    expect(buildSurfaceHeadline(input())!.detail.join(' ')).toContain('62% a year');
    const ranked = buildSurfaceHeadline(input({ ivBand: 'unusually busy' }))!;
    expect(ranked.detail.join(' ')).toContain('unusually busy for this market');
  });

  it('describes the term structure in three directions', () => {
    const flat = buildSurfaceHeadline(input({ term: { nearIv: 0.6, farIv: 0.61 } }))!;
    expect(flat.detail.join(' ')).toContain('about the same as the near ones');

    const up = buildSurfaceHeadline(input({ term: { nearIv: 0.5, farIv: 0.7 } }))!;
    expect(up.detail.join(' ')).toContain('more action further out');

    const inverted = buildSurfaceHeadline(input({ term: { nearIv: 0.7, farIv: 0.5 } }))!;
    expect(inverted.detail.join(' ')).toContain('something is expected soon');
  });

  it('mentions the basis only when it is big enough to matter', () => {
    expect(buildSurfaceHeadline(input({ basisPct: 0.001 }))!.detail.join(' ')).not.toContain('spot price');
    const withBasis = buildSurfaceHeadline(input({ basisPct: 0.12 }))!;
    expect(withBasis.detail.join(' ')).toContain('0.12% above the spot price');
    const below = buildSurfaceHeadline(input({ basisPct: -0.12 }))!;
    expect(below.detail.join(' ')).toContain('0.12% below the spot price');
  });

  it('works with only the move, so a cold surface still says something', () => {
    const bare = buildSurfaceHeadline({
      asset: 'BTC',
      em: EM,
      horizon: null,
      shape: null,
      atmIv: null,
      ivBand: null,
      term: null,
      basisPct: null,
    })!;
    expect(bare.text).toContain('$800');
    expect(bare.detail).toHaveLength(1);
  });
});
