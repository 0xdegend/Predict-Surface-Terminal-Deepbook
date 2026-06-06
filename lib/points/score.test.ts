import { describe, it, expect } from 'vitest';
import { computePoints, POINTS_RATES } from './score';
import type { PositionSummary } from '@/lib/api/types';

const DAY_MS = 86_400_000;
const Q = 1_000_000; // @6dec → 1 DUSDC

/** Minimal PositionSummary for scoring (only the fields computePoints reads). */
function pos(over: Partial<PositionSummary>): PositionSummary {
  return {
    predict_id: '0x0',
    manager_id: '0x0',
    quote_asset: 'DUSDC',
    oracle_id: '0x0',
    underlying_asset: 'BTC',
    expiry: 0,
    strike: 0,
    is_up: true,
    minted_quantity: 0,
    redeemed_quantity: 0,
    open_quantity: 0,
    total_cost: 0,
    total_payout: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    open_cost_basis: 0,
    average_entry_price: 0,
    average_exit_price: 0,
    mark_price: null,
    mark_value: null,
    status: 'redeemed',
    first_minted_at: 0,
    last_activity_at: 0,
    ...over,
  };
}

describe('computePoints', () => {
  it('returns an all-zero breakdown for no positions', () => {
    const b = computePoints([], 1000);
    expect(b).toMatchObject({ liquidity: 0, performance: 0, holding: 0, total: 0, volume: 0, netPnl: 0, avgHoldDays: 0 });
  });

  it('scores liquidity from mint volume', () => {
    const b = computePoints([pos({ total_cost: 100 * Q })], 0);
    expect(b.volume).toBe(100);
    expect(b.liquidity).toBe(100 * POINTS_RATES.perDusdcVolume);
  });

  it('floors performance at zero — a loss never subtracts points', () => {
    const loss = computePoints([pos({ total_cost: 100 * Q, realized_pnl: -50 * Q })], 0);
    expect(loss.netPnl).toBe(-50);
    expect(loss.performance).toBe(0);
    // total is still positive from the liquidity component
    expect(loss.total).toBe(loss.liquidity);
  });

  it('rewards positive PnL at the profit rate', () => {
    const win = computePoints([pos({ total_cost: 100 * Q, realized_pnl: 40 * Q, unrealized_pnl: 10 * Q })], 0);
    expect(win.netPnl).toBe(50);
    expect(win.performance).toBe(50 * POINTS_RATES.perDusdcProfit);
  });

  it('scores holding as liquidity-weighted days in market', () => {
    // 100 DUSDC held for 10 days, fully closed (open_quantity 0 → end = last_activity_at)
    const b = computePoints([pos({ total_cost: 100 * Q, first_minted_at: 0, last_activity_at: 10 * DAY_MS })], 999);
    expect(b.avgHoldDays).toBeCloseTo(10);
    expect(b.holding).toBeCloseTo(100 * 10 * POINTS_RATES.perDusdcDayHeld);
  });

  it('measures an open position to now, not its last activity', () => {
    const now = 5 * DAY_MS;
    const b = computePoints([pos({ total_cost: 100 * Q, open_quantity: 100 * Q, first_minted_at: 0, last_activity_at: DAY_MS })], now);
    expect(b.avgHoldDays).toBeCloseTo(5); // mint→now, ignoring last_activity_at
  });

  it('sums components across positions', () => {
    const b = computePoints(
      [
        pos({ total_cost: 100 * Q, realized_pnl: 20 * Q, first_minted_at: 0, last_activity_at: DAY_MS }),
        pos({ total_cost: 50 * Q, realized_pnl: -10 * Q, first_minted_at: 0, last_activity_at: 2 * DAY_MS }),
      ],
      0,
    );
    expect(b.volume).toBe(150);
    expect(b.netPnl).toBe(10); // 20 + (-10)
    expect(b.liquidity).toBe(150 * POINTS_RATES.perDusdcVolume);
    expect(b.performance).toBe(10 * POINTS_RATES.perDusdcProfit);
    // holding: 100·1 + 50·2 = 200 DUSDC·days
    expect(b.holding).toBeCloseTo(200 * POINTS_RATES.perDusdcDayHeld);
    expect(b.total).toBeCloseTo(b.liquidity + b.performance + b.holding);
  });
});
