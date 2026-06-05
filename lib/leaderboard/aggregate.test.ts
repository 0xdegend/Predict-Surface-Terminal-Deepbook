import { describe, it, expect } from 'vitest';
import {
  aggregateLeaderboard,
  attachPnl,
  sortRows,
  leaderboardTotals,
  type LeaderboardRow,
} from './aggregate';
import type {
  PositionMintedEvent,
  PositionRedeemedEvent,
  ManagerRow,
  ManagerSummary,
} from '@/lib/api/types';

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
    // PositionRedeemedEvent carries `owner` (+ executor) — add via the cast below.
    ...over,
  } as PositionRedeemedEvent;
}

function manager(manager_id: string, owner: string): ManagerRow {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', onchain_timestamp: 0, manager_id, owner,
  };
}

function summary(manager_id: string, owner: string, realized: number, unrealized: number): ManagerSummary {
  return {
    manager_id, owner, balances: [], trading_balance: 0, open_exposure: 0, redeemable_value: 0,
    realized_pnl: realized, unrealized_pnl: unrealized, account_value: realized + unrealized,
    open_positions: 1, awaiting_settlement_positions: 0,
  };
}

describe('aggregateLeaderboard', () => {
  it('folds minted volume + trade count per trader', () => {
    const rows = aggregateLeaderboard(
      [
        minted({ trader: '0xA', cost: 1_000_000, checkpoint_timestamp_ms: 10 }), // 1.0 DUSDC
        minted({ trader: '0xA', cost: 500_000, checkpoint_timestamp_ms: 20 }), //  0.5 DUSDC
        minted({ trader: '0xB', cost: 2_000_000, checkpoint_timestamp_ms: 5 }), // 2.0 DUSDC
      ],
      [],
      [manager('0xm1', '0xA'), manager('0xm2', '0xA'), manager('0xm3', '0xB')],
    );
    // Sorted by volume desc → B (2.0) before A (1.5).
    expect(rows.map((r) => r.owner)).toEqual(['0xB', '0xA']);
    const a = rows.find((r) => r.owner === '0xA')!;
    expect(a.volume).toBeCloseTo(1.5, 9);
    expect(a.trades).toBe(2);
    expect(a.lastActiveMs).toBe(20);
    expect(a.managerIds.sort()).toEqual(['0xm1', '0xm2']);
  });

  it('folds redeem payouts and tracks last activity across both streams', () => {
    const rows = aggregateLeaderboard(
      [minted({ trader: '0xA', cost: 1_000_000, checkpoint_timestamp_ms: 10 })],
      [redeemed({ owner: '0xA', payout: 3_000_000, checkpoint_timestamp_ms: 99 })],
      [manager('0xm1', '0xA')],
    );
    const a = rows[0];
    expect(a.payout).toBeCloseTo(3, 9);
    expect(a.redeems).toBe(1);
    expect(a.lastActiveMs).toBe(99);
  });

  it('omits owners with no activity (managers list alone does not create a row)', () => {
    const rows = aggregateLeaderboard([], [], [manager('0xm1', '0xIdle')]);
    expect(rows).toHaveLength(0);
  });
});

describe('attachPnl', () => {
  it('sums realized + unrealized across an owner’s managers', () => {
    const base: LeaderboardRow[] = [
      { owner: '0xA', volume: 5, trades: 3, redeems: 1, payout: 2, lastActiveMs: 0, managerIds: ['0xm1', '0xm2'] },
    ];
    const summaries = new Map<string, ManagerSummary>([
      ['0xm1', summary('0xm1', '0xA', 1_000_000, -250_000)], // +1.0 / -0.25
      ['0xm2', summary('0xm2', '0xA', 2_000_000, 500_000)], //  +2.0 / +0.5
    ]);
    const [a] = attachPnl(base, summaries);
    expect(a.realizedPnl).toBeCloseTo(3, 9);
    expect(a.unrealizedPnl).toBeCloseTo(0.25, 9);
    expect(a.totalPnl).toBeCloseTo(3.25, 9);
    expect(a.pnlLoaded).toBe(true);
  });

  it('leaves rows without fetched summaries unchanged (pnlLoaded falsy)', () => {
    const base: LeaderboardRow[] = [
      { owner: '0xB', volume: 1, trades: 1, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: ['0xmX'] },
    ];
    const [b] = attachPnl(base, new Map());
    expect(b.totalPnl).toBeUndefined();
    expect(b.pnlLoaded).toBeFalsy();
  });
});

describe('sortRows', () => {
  const rows: LeaderboardRow[] = [
    { owner: '0xA', volume: 1, trades: 9, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: [], totalPnl: -5, pnlLoaded: true },
    { owner: '0xB', volume: 9, trades: 1, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: [], totalPnl: 10, pnlLoaded: true },
    { owner: '0xC', volume: 5, trades: 5, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: [] }, // pnl not loaded
  ];

  it('sorts by volume / trades / pnl', () => {
    expect(sortRows(rows, 'volume').map((r) => r.owner)).toEqual(['0xB', '0xC', '0xA']);
    expect(sortRows(rows, 'trades').map((r) => r.owner)).toEqual(['0xA', '0xC', '0xB']);
    // pnl: B (+10) then A (-5) then C (unloaded → sinks).
    expect(sortRows(rows, 'pnl').map((r) => r.owner)).toEqual(['0xB', '0xA', '0xC']);
  });
});

describe('leaderboardTotals', () => {
  it('sums traders / volume / trades', () => {
    const t = leaderboardTotals([
      { owner: '0xA', volume: 1.5, trades: 2, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: [] },
      { owner: '0xB', volume: 2, trades: 1, redeems: 0, payout: 0, lastActiveMs: 0, managerIds: [] },
    ]);
    expect(t).toEqual({ traders: 2, volume: 3.5, trades: 3 });
  });
});
