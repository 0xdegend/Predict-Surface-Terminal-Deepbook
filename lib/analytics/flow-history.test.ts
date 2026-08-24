import { describe, it, expect } from 'vitest';
import { buildFlowHistory, flowBucketMs, trendOf, TARGET_BUCKETS, type FlowBucket } from './flow-history';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import { toQuote } from '@/config/scale';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const MIN = 60_000;
const NOW = 1_700_000_000_000;

/** A mint. `side` maps to the tick sentinels orderSide reads. */
function mint(tsMs: number, stakeUsd: number, side: 'up' | 'down' | 'range', owner = '0xa'): V2OrderEvent {
  const ticks =
    side === 'up'
      ? { lower_tick: '1000', higher_tick: POS_INF_TICK.toString() }
      : side === 'down'
        ? { lower_tick: '0', higher_tick: '1000' }
        : { lower_tick: '900', higher_tick: '1100' };
  return {
    kind: 'order_minted',
    checkpoint_timestamp_ms: tsMs,
    net_premium: toQuote(stakeUsd).toString(),
    owner,
    ...ticks,
  };
}

const redeem = (tsMs: number): V2OrderEvent => ({ kind: 'settled_order_redeemed', checkpoint_timestamp_ms: tsMs });

describe('flowBucketMs', () => {
  it('picks a round size that lands near the target bar count', () => {
    for (const span of [5 * MIN, 60 * MIN, 24 * 60 * MIN, 7 * 24 * 60 * MIN]) {
      const b = flowBucketMs(span);
      const bars = span / b;
      expect(bars).toBeLessThanOrEqual(TARGET_BUCKETS);
      expect(bars).toBeGreaterThan(1);
    }
  });

  it('never returns zero, even for a degenerate span', () => {
    expect(flowBucketMs(0)).toBeGreaterThan(0);
    expect(flowBucketMs(-1)).toBeGreaterThan(0);
  });
});

describe('buildFlowHistory', () => {
  it('is empty with no mints, but still counts redeems', () => {
    const h = buildFlowHistory([redeem(NOW), redeem(NOW - MIN)], { now: NOW });
    expect(h.bets).toBe(0);
    expect(h.buckets).toEqual([]);
    expect(h.redeems).toBe(2);
    expect(h.trend).toBeNull();
  });

  it('ignores redeems when totalling premium', () => {
    const h = buildFlowHistory([mint(NOW - MIN, 100, 'up'), redeem(NOW)], { now: NOW, bucketMs: MIN });
    expect(h.stakeUsd).toBeCloseTo(100);
    expect(h.bets).toBe(1);
    expect(h.redeems).toBe(1);
  });

  it('splits premium by direction', () => {
    const h = buildFlowHistory(
      [mint(NOW - MIN, 60, 'up'), mint(NOW - MIN, 30, 'down'), mint(NOW - MIN, 10, 'range')],
      { now: NOW, bucketMs: 5 * MIN },
    );
    const b = h.buckets[h.buckets.length - 1];
    expect(b.upStakeUsd).toBeCloseTo(60);
    expect(b.downStakeUsd).toBeCloseTo(30);
    expect(b.rangeStakeUsd).toBeCloseTo(10);
    expect(b.stakeUsd).toBeCloseTo(100);
  });

  it('counts distinct owners, not mints', () => {
    const h = buildFlowHistory(
      [mint(NOW - MIN, 10, 'up', '0xa'), mint(NOW - MIN, 10, 'up', '0xa'), mint(NOW - MIN, 10, 'up', '0xb')],
      { now: NOW, bucketMs: MIN },
    );
    expect(h.bets).toBe(3);
    expect(h.traders).toBe(2);
  });

  it('keeps empty buckets so a quiet stretch reads as quiet', () => {
    const h = buildFlowHistory([mint(NOW - 10 * MIN, 50, 'up'), mint(NOW - MIN, 50, 'up')], {
      now: NOW,
      bucketMs: MIN,
    });
    expect(h.buckets.length).toBeGreaterThan(2);
    expect(h.buckets.some((b) => b.stakeUsd === 0)).toBe(true);
  });

  it('anchors the last bucket to now, not to the last trade', () => {
    // All flow is old; the chart must still run up to the present.
    const h = buildFlowHistory([mint(NOW - 20 * MIN, 50, 'up')], { now: NOW, bucketMs: MIN });
    const last = h.buckets[h.buckets.length - 1];
    expect(last.startMs).toBe(Math.floor(NOW / MIN) * MIN);
    expect(last.stakeUsd).toBe(0);
  });

  it('reports the busiest bucket and the peak used for scaling', () => {
    const h = buildFlowHistory(
      [mint(NOW - 3 * MIN, 10, 'up'), mint(NOW - 2 * MIN, 400, 'up'), mint(NOW - MIN, 20, 'up')],
      { now: NOW, bucketMs: MIN },
    );
    expect(h.peakUsd).toBeCloseTo(400);
    expect(h.busiest!.startMs).toBe(Math.floor((NOW - 2 * MIN) / MIN) * MIN);
  });

  it('drops mints outside the built window rather than mis-bucketing them', () => {
    const h = buildFlowHistory([mint(NOW + 10 * MIN, 999, 'up'), mint(NOW - MIN, 10, 'up')], {
      now: NOW,
      bucketMs: MIN,
    });
    expect(h.stakeUsd).toBeCloseTo(10);
  });

  it('ignores a zero-premium mint', () => {
    const h = buildFlowHistory([mint(NOW - MIN, 0, 'up')], { now: NOW, bucketMs: MIN });
    expect(h.bets).toBe(0);
  });

  it('caps the bucket count so a long-lived market cannot blow up the chart', () => {
    const h = buildFlowHistory([mint(NOW - 5_000 * MIN, 10, 'up')], { now: NOW, bucketMs: MIN });
    expect(h.buckets.length).toBeLessThanOrEqual(TARGET_BUCKETS * 4);
  });
});

describe('trendOf', () => {
  const b = (stakeUsd: number, i: number): FlowBucket => ({
    startMs: i * MIN,
    stakeUsd,
    upStakeUsd: stakeUsd,
    downStakeUsd: 0,
    rangeStakeUsd: 0,
    bets: stakeUsd > 0 ? 1 : 0,
  });

  it('stays null with too little history to judge', () => {
    expect(trendOf([b(10, 0), b(10, 1)])).toBeNull();
  });

  it('stays null when the prior buckets are nearly all empty', () => {
    expect(trendOf([b(0, 0), b(0, 1), b(0, 2), b(50, 3)])).toBeNull();
  });

  it('reads building when the newest bar beats the run rate', () => {
    expect(trendOf([b(10, 0), b(10, 1), b(10, 2), b(40, 3)])).toBe('building');
  });

  it('reads fading when it falls well under', () => {
    expect(trendOf([b(100, 0), b(100, 1), b(100, 2), b(10, 3)])).toBe('fading');
  });

  it('reads steady inside the band', () => {
    expect(trendOf([b(100, 0), b(100, 1), b(100, 2), b(105, 3)])).toBe('steady');
  });
});
