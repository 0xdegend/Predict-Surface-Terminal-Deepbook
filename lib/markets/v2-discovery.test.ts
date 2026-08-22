import { describe, it, expect } from 'vitest';
import {
  cadenceOf,
  activeMarkets,
  recentMarkets,
  groupByCadence,
  strikeGrid,
  maxLeverageX,
  usableMaxLeverageX,
  isClosingSoon,
  isTooCloseToExpiry,
} from './v2-discovery';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';

const MIN = 60_000;

/** Build a V2Market with sane defaults; `created`/`expiry` drive cadence. */
function mkt(over: Partial<V2Market> & { expiry_market_id: string; expiry: number; checkpoint_timestamp_ms: number }): V2Market {
  return {
    pool_vault_id: '0xpool',
    propbook_underlying_id: 1,
    tick_size: '10000000',
    admission_tick_size: '1000000000',
    max_expiry_allocation: '50000000000',
    initial_expiry_cash: '10000000000',
    liquidation_ltv: 850000000,
    max_admission_leverage: 3000000000,
    backing_buffer_lambda: 250000000,
    base_fee: '20000000',
    min_fee: '5000000',
    min_entry_probability: '10000000',
    max_entry_probability: '990000000',
    expiry_fee_window_ms: 86400000,
    expiry_fee_max_multiplier: 1000000000,
    trading_loss_rebate_rate: 500000000,
    kind: 'market_created',
    ...over,
  };
}

describe('cadenceOf', () => {
  it('classifies by creation tenor (≈ windowSize × period)', () => {
    const base = 1_000_000_000;
    expect(cadenceOf(mkt({ expiry_market_id: 'a', checkpoint_timestamp_ms: base, expiry: base + 3 * MIN }))).toBe('1m');
    expect(cadenceOf(mkt({ expiry_market_id: 'b', checkpoint_timestamp_ms: base, expiry: base + 15 * MIN }))).toBe('5m');
    expect(cadenceOf(mkt({ expiry_market_id: 'c', checkpoint_timestamp_ms: base, expiry: base + 180 * MIN }))).toBe('1h');
  });

  it('treats the larger expiry allocation as hourly regardless of tenor', () => {
    const base = 1_000_000_000;
    const m = mkt({ expiry_market_id: 'd', checkpoint_timestamp_ms: base, expiry: base + 3 * MIN, max_expiry_allocation: '250000000000' });
    expect(cadenceOf(m)).toBe('1h');
  });
});

describe('activeMarkets', () => {
  const now = 10_000_000;
  it('drops expired, sorts soonest-first, dedupes by id (freshest event wins)', () => {
    const ms = [
      mkt({ expiry_market_id: 'future2', checkpoint_timestamp_ms: now - MIN, expiry: now + 5 * MIN }),
      mkt({ expiry_market_id: 'past', checkpoint_timestamp_ms: now - 10 * MIN, expiry: now - MIN }),
      mkt({ expiry_market_id: 'future1', checkpoint_timestamp_ms: now - MIN, expiry: now + 2 * MIN }),
      // duplicate id with a STALER event — should be ignored in favor of the fresher one
      mkt({ expiry_market_id: 'future1', checkpoint_timestamp_ms: now - 9 * MIN, expiry: now + 99 * MIN }),
    ];
    const out = activeMarkets(ms, now);
    expect(out.map((m) => m.expiry_market_id)).toEqual(['future1', 'future2']);
    expect(out[0].expiry).toBe(now + 2 * MIN); // fresher event kept
  });
});

describe('recentMarkets', () => {
  const now = 10_000_000;
  const lookback = 20 * MIN;
  it('keeps live markets PLUS those expired within the lookback, newest-expiry-first', () => {
    const ms = [
      mkt({ expiry_market_id: 'live', checkpoint_timestamp_ms: now - MIN, expiry: now + 5 * MIN }),
      mkt({ expiry_market_id: 'justExpired', checkpoint_timestamp_ms: now - 5 * MIN, expiry: now - 2 * MIN }),
      mkt({ expiry_market_id: 'tooOld', checkpoint_timestamp_ms: now - 40 * MIN, expiry: now - 25 * MIN }),
    ];
    const out = recentMarkets(ms, lookback, now);
    // 'tooOld' expired before the cutoff → dropped; newest expiry first.
    expect(out.map((m) => m.expiry_market_id)).toEqual(['live', 'justExpired']);
  });

  it('dedupes by id (freshest event wins), like activeMarkets', () => {
    const ms = [
      mkt({ expiry_market_id: 'x', checkpoint_timestamp_ms: now - MIN, expiry: now + 2 * MIN }),
      mkt({ expiry_market_id: 'x', checkpoint_timestamp_ms: now - 9 * MIN, expiry: now + 99 * MIN }),
    ];
    const out = recentMarkets(ms, lookback, now);
    expect(out).toHaveLength(1);
    expect(out[0].expiry).toBe(now + 2 * MIN); // fresher event kept
  });
});

describe('groupByCadence', () => {
  it('buckets every active market into its cadence', () => {
    const base = 1_000_000_000;
    const ms = [
      mkt({ expiry_market_id: 'a', checkpoint_timestamp_ms: base, expiry: base + 3 * MIN }),
      mkt({ expiry_market_id: 'b', checkpoint_timestamp_ms: base, expiry: base + 15 * MIN }),
      mkt({ expiry_market_id: 'c', checkpoint_timestamp_ms: base, expiry: base + 180 * MIN, max_expiry_allocation: '250000000000' }),
    ];
    const g = groupByCadence(ms);
    expect(g['1m'].map((m) => m.expiry_market_id)).toEqual(['a']);
    expect(g['5m'].map((m) => m.expiry_market_id)).toEqual(['b']);
    expect(g['1h'].map((m) => m.expiry_market_id)).toEqual(['c']);
  });
});

describe('strikeGrid', () => {
  it('centers on the ATM strike, snapped to the admission tick', () => {
    // forward 60398.25, $1 admission tick → ATM 60398, ±2 strikes
    const grid = strikeGrid(60398.25, '1000000000', 2);
    expect(grid).toEqual([60396, 60397, 60398, 60399, 60400]);
  });
});

describe('maxLeverageX', () => {
  it('reads max leverage as a human multiple', () => {
    expect(maxLeverageX(mkt({ expiry_market_id: 'x', checkpoint_timestamp_ms: 0, expiry: MIN }))).toBe(3);
  });
});

describe('usableMaxLeverageX (no-leverage window gate)', () => {
  const now = 10_000_000;
  const W = predictV2Config.noLeverageWindowMs;

  it('is 1x inside the no-leverage window (short markets); nominal cap outside', () => {
    // A 2-minute market: inside the ~60min window when one is configured (8-06) → 1x.
    const short = mkt({ expiry_market_id: 'short', checkpoint_timestamp_ms: now - MIN, expiry: now + 2 * MIN });
    const far = mkt({ expiry_market_id: 'far', checkpoint_timestamp_ms: now - MIN, expiry: now + W + 10 * MIN });
    if (W > 0) {
      expect(usableMaxLeverageX(short, now)).toBe(1); // gated off near expiry
      expect(usableMaxLeverageX(far, now)).toBe(3); // beyond the window → the nominal 3x
    } else {
      // Window disabled (e.g. 6-24 config active) → always the nominal cap.
      expect(usableMaxLeverageX(short, now)).toBe(3);
    }
  });

  it('exactly at the window edge still counts as inside (1x)', () => {
    if (W <= 0) return;
    const atEdge = mkt({ expiry_market_id: 'edge', checkpoint_timestamp_ms: now - MIN, expiry: now + W });
    expect(usableMaxLeverageX(atEdge, now)).toBe(1);
  });
});

describe('isClosingSoon / isTooCloseToExpiry (cadence-keyed, not tenor-fraction)', () => {
  // A 1m market's raw tenor (expiry - checkpoint_timestamp_ms) is ~3min (windowSize),
  // so thresholds must key off cadenceOf(), not a fraction of that tenor.
  const base = 1_000_000_000;
  const oneMin = mkt({ expiry_market_id: '1m', checkpoint_timestamp_ms: base, expiry: base + 3 * MIN });
  const fiveMin = mkt({ expiry_market_id: '5m', checkpoint_timestamp_ms: base, expiry: base + 15 * MIN });
  const hourly = mkt({
    expiry_market_id: '1h',
    checkpoint_timestamp_ms: base,
    expiry: base + 180 * MIN,
    max_expiry_allocation: '250000000000',
  });

  it('1m market: closing-soon/too-close fire in the last ~10s/4s, not ~3min', () => {
    const expiry = oneMin.expiry;
    expect(isClosingSoon(oneMin, expiry - 20_000)).toBe(false);
    expect(isClosingSoon(oneMin, expiry - 8_000)).toBe(true);
    expect(isTooCloseToExpiry(oneMin, expiry - 8_000)).toBe(false);
    expect(isTooCloseToExpiry(oneMin, expiry - 2_000)).toBe(true);
  });

  it('every cadence shares ONE 10s caution window — an hourly used to warn for 2 minutes', () => {
    for (const m of [oneMin, fiveMin, hourly]) {
      expect(isClosingSoon(m, m.expiry - 20_000), m.expiry_market_id).toBe(false);
      expect(isClosingSoon(m, m.expiry - 8_000), m.expiry_market_id).toBe(true);
    }
  });

  it('leaves the caution visibly alive before minting blocks', () => {
    // The banner renders on `closingSoon && !tooCloseToExpiry`. That gap is its whole
    // life, so it must be more than a rounding error on every cadence.
    for (const m of [oneMin, fiveMin, hourly]) {
      const visible = [8, 7, 6].filter(
        (s) => isClosingSoon(m, m.expiry - s * 1000) && !isTooCloseToExpiry(m, m.expiry - s * 1000),
      );
      expect(visible.length, m.expiry_market_id).toBeGreaterThanOrEqual(3);
    }
  });

  it('is false well before expiry', () => {
    expect(isClosingSoon(oneMin, base)).toBe(false);
    expect(isTooCloseToExpiry(oneMin, base)).toBe(false);
  });
});
