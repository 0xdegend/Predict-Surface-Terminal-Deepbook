import { describe, it, expect } from 'vitest';
import { positioningVerdict, type Positioning } from './positioning';

const base: Positioning = {
  available: true,
  asOf: 0,
  maxPain: [{ date: '2026-07-26', maxPainPrice: 64_000, callOi: 1467, putOi: 1027, putCallRatio: 0.7 }],
  options: { totalOiUsd: 3.3e10, deribitSharePct: 85, volume24hUsd: 1.2e9 },
  etfFlow: { netUsd: 210_000_000, asOfDate: '2026-07-24', byFund: [{ ticker: 'IBIT', flowUsd: 112_000_000 }] },
  crowd: { longPct: 60, shortPct: 40 },
  pressure: { buyPct: 41, sellPct: 59 },
  smartMoney: { topLongPct: 66, topShortPct: 34 },
};

describe('positioningVerdict', () => {
  it('reads a bullish setup in plain language', () => {
    const v = positioningVerdict(base, 0.008)!;
    expect(v).toContain('pinned near $64');
    expect(v).toContain('ETFs bought');
    expect(v).toContain('60% long');
    expect(v).toContain('positive funding');
    expect(v).toMatch(/bullish lean/);
  });

  it('flags a stretched lean when the crowd is crowded', () => {
    const v = positioningVerdict({ ...base, crowd: { longPct: 68, shortPct: 32 } }, 0.01)!;
    expect(v).toMatch(/stretched long lean/);
  });

  it('reads selling + short crowd as bearish', () => {
    const v = positioningVerdict(
      { ...base, etfFlow: { netUsd: -240_000_000, asOfDate: '2026-07-25', byFund: [] }, crowd: { longPct: 42, shortPct: 58 } },
      -0.005,
    )!;
    expect(v).toContain('ETFs sold');
    expect(v).toContain('42% long');
    expect(v).toContain('negative funding');
    expect(v).toMatch(/bearish lean/);
  });

  it('degrades: null when unavailable, works with partial data', () => {
    expect(positioningVerdict({ ...base, available: false }, 0)).toBeNull();
    expect(positioningVerdict(null, 0)).toBeNull();
    const partial = positioningVerdict({ available: true, asOf: 0, maxPain: base.maxPain, options: null, etfFlow: null, crowd: null, pressure: null, smartMoney: null }, null)!;
    expect(partial).toContain('pinned near');
  });

  it('omits tiny ETF flow noise (< $1M)', () => {
    const v = positioningVerdict({ ...base, etfFlow: { netUsd: 500_000, asOfDate: '', byFund: [] } }, 0.008)!;
    expect(v).not.toContain('ETFs');
  });
});
