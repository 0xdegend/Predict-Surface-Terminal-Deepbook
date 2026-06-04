import { describe, it, expect } from 'vitest';
import type { Oracle } from '@/lib/api/types';
import { cadenceOf, horizonOf, groupOracles } from './grouping';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Minimal oracle fixture; `ttlMin` sets expiry relative to `now`, `tenorMin` the cadence. */
function oracle(id: string, ttlMin: number, now: number, tenorMin = 119): Oracle {
  const expiry = now + ttlMin * MIN;
  return {
    predict_id: '0xp',
    oracle_id: id,
    oracle_cap_id: '0xc',
    underlying_asset: 'BTC',
    expiry,
    min_strike: 50_000 * 1e9,
    tick_size: 1e9,
    status: 'active',
    activated_at: expiry - tenorMin * MIN,
    settlement_price: null,
    settled_at: null,
    created_checkpoint: 0,
  };
}

describe('cadenceOf (per-card tag)', () => {
  const now = 1_000_000_000_000;
  it('maps the ~2h intraday series to 15m', () => {
    expect(cadenceOf(oracle('a', 30, now, 119))).toBe('15m');
  });
  it('maps the ~5h series to hourly', () => {
    expect(cadenceOf(oracle('b', 50, now, 299))).toBe('hourly');
  });
  it('maps multi-day tenors to daily', () => {
    expect(cadenceOf(oracle('c', 800, now, 5820))).toBe('daily');
  });
});

describe('horizonOf', () => {
  const now = 1_000_000_000_000;
  it('classifies by time-to-expiry, not cadence', () => {
    expect(horizonOf(now + 5 * MIN, now)).toBe('closing');
    expect(horizonOf(now + 15 * MIN, now)).toBe('closing'); // inclusive bound
    expect(horizonOf(now + 45 * MIN, now)).toBe('hour');
    expect(horizonOf(now + 60 * MIN, now)).toBe('hour'); // inclusive bound
    expect(horizonOf(now + 3 * HOUR, now)).toBe('hours');
    expect(horizonOf(now + 30 * HOUR, now)).toBe('days');
    expect(horizonOf(now + 14 * DAY, now)).toBe('weeks');
  });

  it('places a :00 hourly market in the same horizon as its 15-min neighbours', () => {
    // 18:45 (15m, 35m left) and 19:00 (hourly, 50m left) both fall in 'hour' —
    // horizon grouping ignores cadence, so the :00 market no longer breaks the ladder.
    const at1845 = oracle('q45', 35, now, 119);
    const at1900 = oracle('h00', 50, now, 299);
    expect(horizonOf(at1845.expiry, now)).toBe('hour');
    expect(horizonOf(at1900.expiry, now)).toBe('hour');
  });
});

describe('groupOracles', () => {
  const now = 1_000_000_000_000;

  it('orders groups soonest-horizon first and drops empty ones', () => {
    const groups = groupOracles([oracle('d', 800, now), oracle('a', 5, now)], now);
    expect(groups.map((g) => g.horizon)).toEqual(['closing', 'days']);
  });

  it('sorts oracles within a group by soonest expiry', () => {
    const later = oracle('late', 50, now);
    const sooner = oracle('soon', 20, now);
    const groups = groupOracles([later, sooner], now);
    expect(groups[0].oracles.map((o) => o.oracle_id)).toEqual(['soon', 'late']);
  });

  it('keeps the :00 hourly market in sequence with its 15-min neighbours (no gap)', () => {
    const at1845 = oracle('q45', 35, now, 119);
    const at1900 = oracle('h00', 50, now, 299);
    const groups = groupOracles([at1845, at1900], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].horizon).toBe('hour');
    expect(groups[0].oracles.map((o) => o.oracle_id)).toEqual(['q45', 'h00']);
  });

  it('excludes already-expired oracles', () => {
    const expired = oracle('gone', -1, now);
    const live = oracle('live', 30, now);
    const groups = groupOracles([expired, live], now);
    expect(groups.flatMap((g) => g.oracles).map((o) => o.oracle_id)).toEqual(['live']);
  });
});
