import { describe, it, expect } from 'vitest';
import { aggregateLeaderboard, sortRows, leaderboardTotals, type LeaderboardRow } from './aggregate';
import { pointsFromInput, POINTS_RATES } from '@/lib/points/score';
import type { PositionMintedEvent, PositionRedeemedEvent, ManagerRow } from '@/lib/api/types';

const DAY_MS = 86_400_000;
const Q = 1_000_000; // @6dec → 1 unit/DUSDC

function minted(over: Partial<PositionMintedEvent>): PositionMintedEvent {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: 0,
    predict_id: '0xp', manager_id: '0xm', trader: '0xt', quote_asset: 'DUSDC',
    expiry: 0, strike: 0, is_up: true, quantity: 0, cost: 0, ask_price: 0,
    ...over,
  };
}

function redeemed(over: Partial<PositionRedeemedEvent>): PositionRedeemedEvent {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: 0,
    predict_id: '0xp', manager_id: '0xm', quote_asset: 'DUSDC', expiry: 0, strike: 0,
    is_up: true, quantity: 0, payout: 0, bid_price: 0, is_settled: true,
    ...over,
  } as PositionRedeemedEvent;
}

function manager(manager_id: string, owner: string): ManagerRow {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', onchain_timestamp: 0, manager_id, owner,
  };
}

/** A LeaderboardRow with a points score built from explicit inputs. */
function row(owner: string, volume: number, netPnl = 0, dusdcDaysHeld = 0): LeaderboardRow {
  return {
    owner, volume, trades: 0, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: [],
    points: pointsFromInput({ volume, netPnl, dusdcDaysHeld }),
  };
}

describe('aggregateLeaderboard', () => {
  it('folds minted volume + trade count per trader and links managers', () => {
    const rows = aggregateLeaderboard(
      [
        minted({ trader: '0xA', cost: 1 * Q, checkpoint_timestamp_ms: 10 }),
        minted({ trader: '0xA', cost: 0.5 * Q, checkpoint_timestamp_ms: 20 }),
        minted({ trader: '0xB', cost: 2 * Q, checkpoint_timestamp_ms: 5 }),
      ],
      [],
      [manager('0xm1', '0xA'), manager('0xm2', '0xA'), manager('0xm3', '0xB')],
      20, // now ≈ latest mint → negligible holding, so points ≈ volume
    );
    // Ranked by points desc; with ~0 holding & no profit, points ≈ volume → B before A.
    expect(rows.map((r) => r.owner)).toEqual(['0xB', '0xA']);
    const a = rows.find((r) => r.owner === '0xA')!;
    expect(a.volume).toBeCloseTo(1.5, 9);
    expect(a.trades).toBe(2);
    expect(a.lastActiveMs).toBe(20);
    expect(a.managerIds.sort()).toEqual(['0xm1', '0xm2']);
    expect(a.points.total).toBeCloseTo(1.5, 4); // liquidity only
  });

  it('scores performance from the realized-net proxy, floored at zero', () => {
    const win = aggregateLeaderboard(
      [minted({ trader: '0xW', cost: 10 * Q, quantity: 10 * Q, checkpoint_timestamp_ms: 0 })],
      [redeemed({ owner: '0xW', payout: 15 * Q, quantity: 10 * Q, checkpoint_timestamp_ms: 0 })],
      [],
      0,
    )[0];
    // netPnl = 15 − 10 = 5 → performance = 5 · rate; liquidity = 10; holding ≈ 0.
    expect(win.points.performance).toBeCloseTo(5 * POINTS_RATES.perDusdcProfit, 6);

    const loss = aggregateLeaderboard(
      [minted({ trader: '0xL', cost: 10 * Q, quantity: 10 * Q, checkpoint_timestamp_ms: 0 })],
      [redeemed({ owner: '0xL', payout: 4 * Q, quantity: 10 * Q, checkpoint_timestamp_ms: 0 })],
      [],
      0,
    )[0];
    // netPnl = 4 − 10 = −6 → performance floored at 0 (a loss never subtracts).
    expect(loss.points.performance).toBe(0);
  });

  it('scores holding as liquidity-weighted days, FIFO-matched mint→redeem', () => {
    // 10 DUSDC minted at t0, fully redeemed 2 days later → 10·2 = 20 DUSDC·days.
    const r = aggregateLeaderboard(
      [minted({ trader: '0xH', cost: 10 * Q, quantity: 10 * Q, checkpoint_timestamp_ms: 0 })],
      [redeemed({ owner: '0xH', payout: 0, quantity: 10 * Q, checkpoint_timestamp_ms: 2 * DAY_MS })],
      [],
      9 * DAY_MS,
    )[0];
    expect(r.points.avgHoldDays).toBeCloseTo(2, 6);
    expect(r.points.holding).toBeCloseTo(20 * POINTS_RATES.perDusdcDayHeld, 6);
  });

  it('measures a still-open mint lot to now', () => {
    const r = aggregateLeaderboard(
      [minted({ trader: '0xO', cost: 10 * Q, quantity: 10 * Q, checkpoint_timestamp_ms: 0 })],
      [],
      [],
      3 * DAY_MS,
    )[0];
    expect(r.points.avgHoldDays).toBeCloseTo(3, 6);
    expect(r.points.holding).toBeCloseTo(30 * POINTS_RATES.perDusdcDayHeld, 6);
  });

  it('does not cross position keys when FIFO-matching redeems', () => {
    // A redeem on strike B must not close the mint on strike A.
    const r = aggregateLeaderboard(
      [minted({ trader: '0xK', cost: 10 * Q, quantity: 10 * Q, strike: 1, checkpoint_timestamp_ms: 0 })],
      [redeemed({ owner: '0xK', quantity: 10 * Q, strike: 2, checkpoint_timestamp_ms: DAY_MS })],
      [],
      4 * DAY_MS,
    )[0];
    // The strike-1 lot stays open → measured to now (4 days), unaffected by the strike-2 redeem.
    expect(r.points.avgHoldDays).toBeCloseTo(4, 6);
  });

  it('omits owners with no activity (managers list alone does not create a row)', () => {
    expect(aggregateLeaderboard([], [], [manager('0xm1', '0xIdle')], 0)).toHaveLength(0);
  });
});

describe('sortRows', () => {
  // A: tiny volume but big profit → high points. B: big volume, no profit. C: middle.
  const rows: LeaderboardRow[] = [row('0xA', 1, 100), row('0xB', 9, 0), row('0xC', 5, 0)];

  it('ranks by points (default), breaking ties by volume', () => {
    // points: A = 1 + 200 = 201, B = 9, C = 5.
    expect(sortRows(rows, 'points').map((r) => r.owner)).toEqual(['0xA', '0xB', '0xC']);
  });

  it('ranks by volume when chosen', () => {
    expect(sortRows(rows, 'volume').map((r) => r.owner)).toEqual(['0xB', '0xC', '0xA']);
  });
});

describe('leaderboardTotals', () => {
  it('sums traders / volume / trades', () => {
    const t = leaderboardTotals([
      { ...row('0xA', 1.5), trades: 2 },
      { ...row('0xB', 2), trades: 1 },
    ]);
    expect(t).toEqual({ traders: 2, volume: 3.5, trades: 3 });
  });
});
