import { describe, it, expect } from 'vitest';
import { buildTermStructure, reconstructAtmIvHistory } from './vol-curves';
import { FLOAT_SCALING } from '@/config/scale';
import { impliedVol, timeToExpiryYears, type SviFloat } from '@/lib/svi/svi';
import type { MarketCell } from '@/lib/analytics/market-grid';
import type { SviEvent, PriceEvent } from '@/lib/api/types';

const E9 = FLOAT_SCALING;
const HOUR = 3_600_000;

function cell(over: Partial<MarketCell>): MarketCell {
  return {
    oracleId: '0xA', underlying: 'BTC', expiry: 0, forward: 63_000, atmIv: 1.1,
    volume: 0, trades: 0, openInterest: 0, upShare: 0.5, totalCost: 0,
    atmStrike: 63_000, atmStrikeScaled: String(63_000 * E9),
    ...over,
  };
}

function svi(tsMs: number): SviEvent {
  // a=0.0004, b=0.001, rho=-0.2, m=0, sigma=0.05 → w(0) > 0 → finite ATM IV.
  return {
    event_digest: 'd', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: tsMs,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: tsMs,
    a: 0.0004 * E9, b: 0.001 * E9, rho: 0.2 * E9, rho_negative: true,
    m: 0, m_negative: false, sigma: 0.05 * E9,
  };
}

function price(tsMs: number, forward: number): PriceEvent {
  return {
    event_digest: 'd', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: tsMs,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: tsMs,
    spot: forward * E9, forward: forward * E9,
  };
}

describe('buildTermStructure', () => {
  it('maps live cells to ATM-IV points sorted by expiry, dropping expired/bad', () => {
    const now = 1_000_000;
    const cells = [
      cell({ oracleId: '0xLate', expiry: now + 2 * HOUR, atmIv: 1.2 }),
      cell({ oracleId: '0xSoon', expiry: now + HOUR, atmIv: 1.5 }),
      cell({ oracleId: '0xPast', expiry: now - HOUR, atmIv: 1.0 }), // expired → dropped
      cell({ oracleId: '0xNaN', expiry: now + HOUR, atmIv: NaN }), // non-finite → dropped
    ];
    const term = buildTermStructure(cells, now);
    expect(term.map((p) => p.oracleId)).toEqual(['0xSoon', '0xLate']);
    expect(term[0].tYears).toBeGreaterThan(0);
    expect(term[0].atmIv).toBeCloseTo(1.5);
  });
});

describe('reconstructAtmIvHistory', () => {
  const expiry = 100 * HOUR;

  it('rebuilds ATM IV per snapshot using the forward in force then, ascending', () => {
    // Provided newest-first; forwards change between snapshots.
    const sviHist = [svi(3 * HOUR), svi(1 * HOUR)];
    const priceHist = [price(2 * HOUR, 64_000), price(0, 63_000)];
    const series = reconstructAtmIvHistory(sviHist, priceHist, expiry);

    expect(series.map((p) => p.ts)).toEqual([1 * HOUR, 3 * HOUR]); // sorted ascending
    expect(series).toHaveLength(2);
    // First snapshot (t=1h) sees forward from t=0 (63k); second (t=3h) sees 64k.
    const expected0 = impliedVol(63_000, 63_000, parseSviLocal(), timeToExpiryYears(expiry, 1 * HOUR));
    expect(series[0].atmIv).toBeCloseTo(expected0, 9);
    expect(series.every((p) => p.atmIv > 0)).toBe(true);
  });

  it('skips snapshots with no prior forward or past expiry', () => {
    const sviHist = [svi(1 * HOUR), svi(200 * HOUR)]; // 2nd is past expiry
    const priceHist = [price(2 * HOUR, 63_000)]; // first svi has NO price at-or-before
    const series = reconstructAtmIvHistory(sviHist, priceHist, expiry);
    expect(series).toHaveLength(0);
  });
});

// Mirror the fixture's SVI params in float space for the golden assertion.
function parseSviLocal(): SviFloat {
  return { a: 0.0004, b: 0.001, rho: -0.2, m: 0, sigma: 0.05 };
}
