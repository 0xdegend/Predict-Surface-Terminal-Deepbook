import { describe, it, expect } from 'vitest';
import { derivePortfolioHistory } from './history';
import type { PositionSummary } from '@/lib/api/types';

const Q = 1_000_000; // 6dec
const P = 1_000_000_000; // 1e9 price scale

/** Minimal position fixture; amounts given in human units and scaled here. */
function pos(over: Partial<PositionSummary> & { status: string }): PositionSummary {
  return {
    predict_id: '0xp',
    manager_id: '0xm',
    quote_asset: '0xq',
    oracle_id: '0xo',
    underlying_asset: 'BTC',
    expiry: 1_000,
    strike: 65_000 * P,
    is_up: true,
    minted_quantity: 10 * Q,
    redeemed_quantity: 0,
    open_quantity: 0,
    total_cost: 0,
    total_payout: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    open_cost_basis: 0,
    average_entry_price: 0.5 * P,
    average_exit_price: 0,
    mark_price: null,
    mark_value: null,
    first_minted_at: 0,
    last_activity_at: 0,
    ...over,
  } as PositionSummary;
}

describe('derivePortfolioHistory', () => {
  it('keeps only closed (redeemed/lost) rows, not active or redeemable', () => {
    const { history, stats } = derivePortfolioHistory([
      pos({ status: 'active', open_quantity: 5 * Q }),
      pos({ status: 'redeemable', open_quantity: 10 * Q }),
      pos({ status: 'redeemed', total_cost: 9.5 * Q, total_payout: 10 * Q, redeemed_quantity: 10 * Q }),
      pos({ status: 'lost', total_cost: 2 * Q, open_quantity: 10 * Q }),
    ]);
    expect(history).toHaveLength(2);
    expect(stats.unclaimed).toBe(1); // the redeemable one
  });

  it('computes PnL as payout − cost for a redeemed win', () => {
    const { history } = derivePortfolioHistory([
      pos({ status: 'redeemed', total_cost: 2.216 * Q, total_payout: 5 * Q, redeemed_quantity: 10 * Q }),
    ]);
    expect(history[0].result).toBe('won');
    expect(history[0].pnl).toBeCloseTo(2.784, 6);
    expect(history[0].roi).toBeCloseTo(2.784 / 2.216, 6);
  });

  it('recovers the true −cost loss for a `lost` row despite realized_pnl=0', () => {
    // lost rows carry realized_pnl:0 and payout:0 — payout−cost must give −cost.
    const { history, stats } = derivePortfolioHistory([
      pos({ status: 'lost', total_cost: 1.343 * Q, total_payout: 0, open_quantity: 10 * Q, realized_pnl: 0 }),
    ]);
    expect(history[0].result).toBe('lost');
    expect(history[0].pnl).toBeCloseTo(-1.343, 6);
    expect(stats.realizedPnl).toBeCloseTo(-1.343, 6);
  });

  it('tallies win rate, best/worst and a current streak (newest first)', () => {
    const { stats, history } = derivePortfolioHistory([
      pos({ status: 'lost', total_cost: 3 * Q, last_activity_at: 100 }), // oldest
      pos({ status: 'redeemed', total_cost: 1 * Q, total_payout: 5 * Q, last_activity_at: 200 }),
      pos({ status: 'redeemed', total_cost: 2 * Q, total_payout: 3 * Q, last_activity_at: 300 }), // newest
    ]);
    expect(history[0].settledAt).toBe(300); // sorted newest-first
    expect(stats.total).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(2 / 3, 6);
    expect(stats.best).toBeCloseTo(4, 6); // the +5−1 win
    expect(stats.worst).toBeCloseTo(-3, 6); // the lost −3
    expect(stats.streak).toEqual({ result: 'won', count: 2 }); // two newest are wins
  });

  it('is empty-safe', () => {
    const { history, stats } = derivePortfolioHistory([]);
    expect(history).toEqual([]);
    expect(stats).toMatchObject({ total: 0, wins: 0, losses: 0, winRate: 0, streak: null });
  });
});
