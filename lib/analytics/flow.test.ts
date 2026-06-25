import { describe, it, expect } from 'vitest';
import {
  buildFlowTape,
  aggregateSentiment,
  sentimentByOracle,
  fromMinted,
  fromRedeemed,
} from './flow';
import { FLOAT_SCALING } from '@/config/scale';
import type { PositionMintedEvent, PositionRedeemedEvent } from '@/lib/api/types';

const Q = 1_000_000; // @6dec → 1 DUSDC

function minted(over: Partial<PositionMintedEvent>): PositionMintedEvent {
  return {
    event_digest: 'd', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: 0,
    predict_id: '0xp', manager_id: '0xm', trader: '0xt', quote_asset: 'DUSDC',
    expiry: 0, strike: 0, is_up: true, quantity: 0, cost: 0, ask_price: 0,
    ...over,
  };
}

function redeemed(over: Partial<PositionRedeemedEvent>): PositionRedeemedEvent {
  return {
    event_digest: 'd', digest: '', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', oracle_id: '0xA', onchain_timestamp: 0,
    predict_id: '0xp', manager_id: '0xm', owner: '0xo', executor: '0xo', quote_asset: 'DUSDC',
    expiry: 0, strike: 0, is_up: false, quantity: 0, payout: 0, bid_price: 0, is_settled: true,
    ...over,
  } as PositionRedeemedEvent;
}

describe('flow normalization', () => {
  it('de-scales a mint into floats and tags it a mint', () => {
    const f = fromMinted(
      minted({ strike: 100_000 * FLOAT_SCALING, quantity: 5 * Q, cost: 2 * Q, ask_price: 0.4 * FLOAT_SCALING }),
    );
    expect(f.kind).toBe('mint');
    expect(f.strike).toBeCloseTo(100_000);
    expect(f.quantity).toBeCloseTo(5);
    expect(f.amount).toBeCloseTo(2);
    expect(f.price).toBeCloseTo(0.4);
    expect(f.trader).toBe('0xt');
  });

  it('credits the OWNER (not executor) on a redeem and carries settled', () => {
    const f = fromRedeemed(redeemed({ owner: '0xowner', executor: '0xkeeper', payout: 3 * Q }));
    expect(f.kind).toBe('redeem');
    expect(f.trader).toBe('0xowner');
    expect(f.amount).toBeCloseTo(3);
    expect(f.settled).toBe(true);
  });
});

describe('buildFlowTape', () => {
  it('merges both streams newest-first and respects the limit', () => {
    const m = [minted({ event_index: 1, checkpoint_timestamp_ms: 100 }), minted({ event_index: 2, checkpoint_timestamp_ms: 300 })];
    const r = [redeemed({ event_index: 3, checkpoint_timestamp_ms: 200 })];
    const tape = buildFlowTape(m, r, 2);
    expect(tape).toHaveLength(2);
    expect(tape.map((t) => t.ts)).toEqual([300, 200]); // newest first, oldest dropped
  });

  it('de-dupes by event id', () => {
    const m = [minted({ event_digest: 'x', event_index: 1 }), minted({ event_digest: 'x', event_index: 1 })];
    expect(buildFlowTape(m, [])).toHaveLength(1);
  });
});

describe('aggregateSentiment', () => {
  it('splits UP vs DOWN dollars and computes upShare', () => {
    const m = [
      minted({ is_up: true, cost: 3 * Q }),
      minted({ is_up: false, cost: 1 * Q }),
    ];
    const s = aggregateSentiment(m);
    expect(s.upCost).toBeCloseTo(3);
    expect(s.downCost).toBeCloseTo(1);
    expect(s.totalCost).toBeCloseTo(4);
    expect(s.upShare).toBeCloseTo(0.75);
    expect(s.upCount).toBe(1);
    expect(s.downCount).toBe(1);
  });

  it('is neutral (0.5) with no flow and honors the sinceMs window', () => {
    expect(aggregateSentiment([]).upShare).toBe(0.5);
    const m = [minted({ checkpoint_timestamp_ms: 50, cost: 9 * Q })];
    expect(aggregateSentiment(m, 100).totalCost).toBe(0); // older than window → excluded
  });
});

describe('sentimentByOracle', () => {
  it('keys sentiment per oracle', () => {
    const m = [
      minted({ oracle_id: '0xA', is_up: true, cost: 2 * Q }),
      minted({ oracle_id: '0xB', is_up: false, cost: 5 * Q }),
    ];
    const byO = sentimentByOracle(m);
    expect(byO.get('0xA')!.upShare).toBeCloseTo(1);
    expect(byO.get('0xB')!.upShare).toBeCloseTo(0);
    expect(byO.get('0xB')!.totalCost).toBeCloseTo(5);
  });
});
