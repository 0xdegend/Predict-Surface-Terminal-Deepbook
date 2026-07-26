import { describe, it, expect } from 'vitest';
import { aggregateStrikeVolume, busiestStrikeReply, surfaceVolumeReply, type StrikeVolume } from './strike-volume';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import { toQuote } from '@/config/scale';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

const NOW = 1_700_000_000_000;
// tick_size 1e9-scaled so toFloat → 1, i.e. tick index == strike price (clean).
const market = (id: string, minOut: number) => ({ expiry_market_id: id, expiry: NOW + minOut * 60_000, tick_size: '1000000000' }) as unknown as V2Market;

// net_premium is a base-unit value on the wire (string/number), not a bigint.
const prem = (premium: number) => Number(toQuote(premium));
const mintUp = (strike: number, premium: number): V2OrderEvent => ({ kind: 'order_minted', lower_tick: strike, higher_tick: POS_INF_TICK.toString(), net_premium: prem(premium) });
const mintDown = (strike: number, premium: number): V2OrderEvent => ({ kind: 'order_minted', lower_tick: 0, higher_tick: strike, net_premium: prem(premium) });
const mintRange = (lo: number, hi: number, premium: number): V2OrderEvent => ({ kind: 'order_minted', lower_tick: lo, higher_tick: hi, net_premium: prem(premium) });

describe('aggregateStrikeVolume', () => {
  it('buckets mints by strike, sums premium, busiest first', () => {
    const orders = [
      mintUp(65_000, 100),
      mintUp(65_000, 50), // same strike → merges to $150 / 2 bets
      mintDown(64_000, 30),
      mintRange(63_000, 66_000, 10),
      { kind: 'order_redeemed', lower_tick: 65_000, higher_tick: POS_INF_TICK.toString(), net_premium: prem(999) } as V2OrderEvent, // ignored (not a mint)
    ];
    const out = aggregateStrikeVolume([{ market: market('m1', 5), orders }]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ direction: 'up', strike: 65_000, volume: 150, bets: 2 });
    expect(out[1]).toMatchObject({ direction: 'down', strike: 64_000, volume: 30 });
    expect(out[2]).toMatchObject({ direction: 'range', band: { lower: 63_000, higher: 66_000 }, volume: 10 });
  });

  it('keeps the same strike on different expiries as separate buckets', () => {
    const out = aggregateStrikeVolume([
      { market: market('m1', 2), orders: [mintUp(65_000, 40)] },
      { market: market('m2', 6), orders: [mintUp(65_000, 90)] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ marketId: 'm2', volume: 90 }); // busiest first
    expect(out[1]).toMatchObject({ marketId: 'm1', volume: 40 });
  });

  it('empty / no mints → no buckets', () => {
    expect(aggregateStrikeVolume([])).toEqual([]);
    expect(aggregateStrikeVolume([{ market: market('m1', 5), orders: [] }])).toEqual([]);
  });
});

describe('busiestStrikeReply', () => {
  const buckets: StrikeVolume[] = [
    { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'up', strike: 65_000, volume: 150, bets: 2 },
    { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'down', strike: 64_000, volume: 30, bets: 1 },
    { marketId: 'm2', expiry: NOW + 60 * 60_000, direction: 'range', band: { lower: 63_000, higher: 66_000 }, volume: 10, bets: 1 },
  ];

  it('names the busiest strike + a next-busiest list (scope: now, no settle note)', () => {
    const blob = busiestStrikeReply(buckets, { scope: 'now', now: NOW }).text.join(' ');
    expect(blob).toMatch(/busiest strike on the live market right now is UP \$65,000/);
    expect(blob).toMatch(/\$150 staked across 2 bets/);
    expect(blob).toMatch(/Next busiest:/);
    expect(blob).not.toMatch(/settles/); // 'now' scope is a single market
  });

  it('notes each expiry when scoped across all open markets', () => {
    const blob = busiestStrikeReply(buckets, { scope: 'all', now: NOW }).text.join(' ');
    expect(blob).toMatch(/across all open markets/);
    expect(blob).toMatch(/settles/); // each line carries its expiry
  });

  it('quiet market → an honest "no bets yet" answer', () => {
    expect(busiestStrikeReply([], { scope: 'now', now: NOW }).text.join(' ')).toMatch(/no bets|quiet/i);
    expect(busiestStrikeReply([], { scope: 'all', now: NOW }).text.join(' ')).toMatch(/no bets|quiet/i);
  });

  it('avoids trader jargon', () => {
    const BANNED = ['edge', 'basis point', 'sigma', 'implied vol', 'skew', 'delta', 'gamma', 'tape', 'moneyness', 'theta'];
    const blob = busiestStrikeReply(buckets, { scope: 'all', now: NOW }).text.join(' ').toLowerCase();
    for (const w of BANNED) expect(blob, w).not.toContain(w);
  });
});

describe('surfaceVolumeReply', () => {
  const buckets: StrikeVolume[] = [
    { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'up', strike: 65_000, volume: 150, bets: 2 },
    { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'down', strike: 64_000, volume: 30, bets: 1 },
    { marketId: 'm2', expiry: NOW + 60 * 60_000, direction: 'range', band: { lower: 63_000, higher: 66_000 }, volume: 10, bets: 1 },
  ];

  it('reads total staked, the up-vs-down lean, and the busiest spot', () => {
    const blob = surfaceVolumeReply(buckets, { scope: 'now', now: NOW }).text.join(' ');
    expect(blob).toMatch(/\$190 is staked on the live market right now, across 4 bets/);
    expect(blob).toMatch(/leaning UP: \$150 \(79%\) betting higher vs \$30 \(16%\) lower, plus \$10 in range bets/);
    expect(blob).toMatch(/busiest spot is UP \$65,000 with \$150/);
    expect(blob).not.toMatch(/—/); // no em-dash in the new copy
  });

  it('calls a balanced book an even split', () => {
    const even: StrikeVolume[] = [
      { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'up', strike: 65_000, volume: 100, bets: 2 },
      { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'down', strike: 64_000, volume: 100, bets: 2 },
    ];
    expect(surfaceVolumeReply(even, { scope: 'now', now: NOW }).text.join(' ')).toMatch(/split fairly evenly/);
  });

  it('an all-range book says so instead of a side', () => {
    const r: StrikeVolume[] = [
      { marketId: 'm1', expiry: NOW + 5 * 60_000, direction: 'range', band: { lower: 63_000, higher: 66_000 }, volume: 40, bets: 1 },
    ];
    expect(surfaceVolumeReply(r, { scope: 'now', now: NOW }).text.join(' ')).toMatch(/all range bets/);
  });

  it('quiet surface → an honest "no bets yet" answer', () => {
    expect(surfaceVolumeReply([], { scope: 'now', now: NOW }).text.join(' ')).toMatch(/quiet|no bets/i);
    expect(surfaceVolumeReply([], { scope: 'all', now: NOW }).text.join(' ')).toMatch(/quiet|no bets/i);
  });

  it('avoids trader jargon', () => {
    const BANNED = ['edge', 'basis point', 'sigma', 'implied vol', 'skew', 'delta', 'gamma', 'tape', 'moneyness', 'theta'];
    const blob = surfaceVolumeReply(buckets, { scope: 'all', now: NOW }).text.join(' ').toLowerCase();
    for (const w of BANNED) expect(blob, w).not.toContain(w);
  });
});
