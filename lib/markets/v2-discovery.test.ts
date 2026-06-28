import { describe, it, expect } from 'vitest';
import {
  cadenceOf,
  activeMarkets,
  groupByCadence,
  strikeGrid,
  maxLeverageX,
} from './v2-discovery';
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
