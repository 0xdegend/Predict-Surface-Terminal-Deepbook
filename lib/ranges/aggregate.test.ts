import { describe, it, expect } from 'vitest';
import { aggregateRangePositions, valueRange } from './aggregate';
import type { RangeMintedEvent, RangeRedeemedEvent } from '@/lib/api/types';

const Q = 1_000_000; // @6dec → 1 contract

function minted(over: Partial<RangeMintedEvent>): RangeMintedEvent {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA',
    predict_id: '0xp', manager_id: '0xm', trader: '0xt', quote_asset: 'DUSDC',
    expiry: 100, lower_strike: 60e9, higher_strike: 65e9, quantity: 0, cost: 0, ask_price: 0,
    ...over,
  };
}

function redeemed(over: Partial<RangeRedeemedEvent>): RangeRedeemedEvent {
  return {
    event_digest: '', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA',
    predict_id: '0xp', manager_id: '0xm', trader: '0xt', quote_asset: 'DUSDC',
    expiry: 100, lower_strike: 60e9, higher_strike: 65e9, quantity: 0, payout: 0,
    bid_price: 0, is_settled: false,
    ...over,
  };
}

describe('aggregateRangePositions', () => {
  it('nets minted − redeemed by RangeKey and pro-rates cost basis', () => {
    const rows = aggregateRangePositions(
      [minted({ quantity: 4 * Q, cost: 2 * Q, ask_price: 500_000_000, checkpoint_timestamp_ms: 10 })],
      [redeemed({ quantity: 1 * Q, payout: 0.7 * Q, checkpoint_timestamp_ms: 20 })],
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.openQty).toBe(3 * Q);
    // pro-rata: 3/4 of $2 cost stays open → $1.5 basis; redeemed cost = $0.5.
    expect(r.openCostBasis).toBeCloseTo(1.5 * Q, 3);
    expect(r.realizedPnl).toBeCloseTo(0.7 * Q - 0.5 * Q, 3); // payout − redeemed cost
    expect(r.avgEntryPrice).toBeCloseTo(500_000_000, 3);
    expect(r.firstMintedAt).toBe(10);
    expect(r.lastActivityAt).toBe(20);
  });

  it('separates different bands on the same oracle/expiry', () => {
    const rows = aggregateRangePositions(
      [
        minted({ lower_strike: 60e9, higher_strike: 65e9, quantity: Q, cost: Q }),
        minted({ lower_strike: 65e9, higher_strike: 70e9, quantity: 2 * Q, cost: Q }),
      ],
      [],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].openQty).toBe(2 * Q); // sorted: larger open first
  });

  it('values an open range at fair × openQty', () => {
    const [r] = aggregateRangePositions(
      [minted({ quantity: 5 * Q, cost: 2 * Q })],
      [],
    );
    const v = valueRange(r, 0.5);
    expect(v.currentValue).toBeCloseTo(2.5 * Q, 3); // 0.5 × 5 contracts
    expect(v.unrealizedPnl).toBeCloseTo(2.5 * Q - 2 * Q, 3); // value − $2 basis
  });
});
