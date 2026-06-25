import { describe, it, expect } from 'vitest';
import { classifyStyle, computeStyleStats } from './trader-style';
import { FLOAT_SCALING } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';

const Q = 1_000_000; // @6dec → 1 DUSDC
const E9 = FLOAT_SCALING;

function pos(over: Partial<PositionSummary>): PositionSummary {
  return {
    predict_id: '0xp', manager_id: '0xm', quote_asset: 'DUSDC', oracle_id: '0xA',
    underlying_asset: 'BTC', expiry: 0, strike: 0, is_up: true,
    minted_quantity: 0, redeemed_quantity: 0, open_quantity: 0,
    total_cost: 1 * Q, total_payout: 0, realized_pnl: 0, unrealized_pnl: 0,
    open_cost_basis: 0, average_entry_price: 0.5 * E9, average_exit_price: 0,
    mark_price: null, mark_value: null, status: 'redeemed',
    first_minted_at: 0, last_activity_at: 0,
    ...over,
  } as PositionSummary;
}

describe('computeStyleStats', () => {
  it('cost-weights entry price and shares; counts distinct markets', () => {
    const s = computeStyleStats([
      pos({ oracle_id: '0xA', total_cost: 3 * Q, average_entry_price: 0.2 * E9, is_up: true }),
      pos({ oracle_id: '0xB', total_cost: 1 * Q, average_entry_price: 0.8 * E9, is_up: false }),
    ]);
    expect(s.positions).toBe(2);
    expect(s.volume).toBeCloseTo(4);
    expect(s.avgBet).toBeCloseTo(2);
    expect(s.avgEntry).toBeCloseTo((0.2 * 3 + 0.8 * 1) / 4); // 0.35
    expect(s.tailShare).toBeCloseTo(0.75); // the 3-DUSDC bet @0.2 is a longshot
    expect(s.favShare).toBeCloseTo(0.25);
    expect(s.upShare).toBeCloseTo(0.75);
    expect(s.markets).toBe(2);
  });

  it('ignores zero-cost rows', () => {
    expect(computeStyleStats([pos({ total_cost: 0 })]).positions).toBe(0);
  });
});

describe('classifyStyle', () => {
  it('returns null primary below the sample floor', () => {
    expect(classifyStyle([pos({})]).primary).toBeNull();
  });

  it('flags a tail hunter from cheap longshots', () => {
    const longshots = Array.from({ length: 4 }, () => pos({ average_entry_price: 0.1 * E9 }));
    expect(classifyStyle(longshots).primary?.id).toBe('tail');
  });

  it('flags a favorite backer from high-priced bets', () => {
    const favs = Array.from({ length: 4 }, () => pos({ average_entry_price: 0.85 * E9 }));
    expect(classifyStyle(favs).primary?.id).toBe('favorite');
  });

  it('flags a range trader when range volume dominates', () => {
    const bins = Array.from({ length: 3 }, () => pos({ average_entry_price: 0.5 * E9, total_cost: 1 * Q }));
    expect(classifyStyle(bins, 10).primary?.id).toBe('range'); // 10 range vs 3 binary
  });

  it('flags a high roller on big average tickets', () => {
    const big = Array.from({ length: 3 }, () => pos({ total_cost: 8 * Q, average_entry_price: 0.5 * E9 }));
    expect(classifyStyle(big).primary?.id).toBe('highroller');
  });

  it('adds a direction-bias tag', () => {
    const upHeavy = Array.from({ length: 4 }, () => pos({ is_up: true, average_entry_price: 0.5 * E9 }));
    const style = classifyStyle(upHeavy);
    expect(style.tags.some((t) => t.id === 'up-biased')).toBe(true);
  });

  it('falls back to all-rounder for a balanced mid-price book', () => {
    const mid = [
      pos({ oracle_id: '0xA', average_entry_price: 0.5 * E9, is_up: true }),
      pos({ oracle_id: '0xB', average_entry_price: 0.45 * E9, is_up: false }),
      pos({ oracle_id: '0xC', average_entry_price: 0.55 * E9, is_up: true }),
    ];
    expect(classifyStyle(mid).primary?.id).toBe('balanced');
  });
});
