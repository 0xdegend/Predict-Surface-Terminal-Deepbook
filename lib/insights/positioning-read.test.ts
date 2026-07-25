import { describe, it, expect } from 'vitest';
import { positioningLines, flowLines, optionsLines, smartMoneyLine, pressureLine, squeezeLine } from './positioning-read';
import type { Positioning } from './positioning';

const P: Positioning = {
  available: true,
  asOf: 0,
  maxPain: [{ date: '2026-07-26', maxPainPrice: 64_000, callOi: 1467, putOi: 1027, putCallRatio: 0.7 }],
  options: { totalOiUsd: 3.37e10, deribitSharePct: 85, volume24hUsd: 1.2e9 },
  etfFlow: { netUsd: -240_000_000, asOfDate: '2026-07-25', byFund: [{ ticker: 'IBIT', flowUsd: -212_000_000 }] },
  crowd: { longPct: 64.7, shortPct: 35.3 },
  pressure: { buyPct: 40.7, sellPct: 59.3 },
  smartMoney: { topLongPct: 65.9, topShortPct: 34.1 },
};

describe('positioningLines', () => {
  const lines = positioningLines(P, 0.008);
  const blob = lines.join(' ');

  it('covers crowd, smart money, and order-flow pressure in plain words', () => {
    expect(blob).toContain('65% are betting up'); // crowd
    expect(blob).toMatch(/biggest traders/); // smart money
    expect(blob).toMatch(/Sellers are in control/); // pressure (59% sell)
    expect(blob).toMatch(/crowded long/); // squeeze (64.7% > 62)
  });

  it('names smart-money vs crowd agreement', () => {
    expect(smartMoneyLine(P)).toMatch(/roughly in line with the crowd/); // 65.9 vs 64.7 → within 6
    const bullishTop = smartMoneyLine({ ...P, smartMoney: { topLongPct: 75, topShortPct: 25 } });
    expect(bullishTop).toMatch(/more bullish than the wider crowd/);
  });

  it('reads pressure direction correctly', () => {
    expect(pressureLine({ ...P, pressure: { buyPct: 62, sellPct: 38 } })).toMatch(/Buyers are in control/);
    expect(pressureLine({ ...P, pressure: { buyPct: 50, sellPct: 50 } })).toMatch(/roughly balanced/);
  });

  it('no squeeze note when neither side is crowded', () => {
    expect(squeezeLine({ ...P, crowd: { longPct: 52, shortPct: 48 } }, 0.008)).toBeNull();
  });

  it('uses no options jargon (plain language rule)', () => {
    const all = [...positioningLines(P, 0.008), ...flowLines(P), ...optionsLines(P)].join(' ').toLowerCase();
    for (const banned of [' call ', ' put ', 'sigma', 'basis point', 'delta', 'gamma', 'theta', 'open interest', 'implied vol', 'skew']) {
      expect(all).not.toContain(banned);
    }
  });
});

describe('flowLines & optionsLines', () => {
  it('reads institutional flow as money in/out', () => {
    expect(flowLines(P).join(' ')).toMatch(/Spot ETFs sold .* institutional money heading out/);
  });

  it('reads the options pin + tilt in plain words', () => {
    const o = optionsLines(P).join(' ');
    expect(o).toContain('pinned near $64');
    expect(o).toMatch(/more up bets than down/); // p/c 0.7 < 0.9
    expect(o).toMatch(/Deribit holds about 85%/);
  });

  it('degrades to empty without data', () => {
    expect(positioningLines(null, null)).toEqual([]);
    expect(flowLines({ ...P, available: false })).toEqual([]);
  });
});
