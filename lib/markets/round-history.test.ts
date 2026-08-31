import { describe, it, expect } from 'vitest';
import { settledOutcome, upCount, pickHistoryRounds, MIN_FOR_TAPE } from './round-history';
import { FLOAT_SCALING } from '@/config/scale';
import type { V2Market, V2MarketState } from '@/lib/api/v2/types';

const TICK = String(FLOAT_SCALING / 100); // 0.01 per tick — the live 1m/5m grid
const SCALE = BigInt(FLOAT_SCALING);

/** A finished round, shaped like the live rows the .live test printed. */
function market(over: Partial<V2Market> = {}): V2Market {
  return {
    expiry_market_id: '0xm1',
    expiry: 1_700_000_000_000,
    tick_size: TICK,
    admission_tick_size: TICK,
    ...over,
  } as V2Market;
}

function state(over: Partial<V2MarketState> = {}): V2MarketState {
  return {
    expiry_market_id: '0xm1',
    // 7268872 ticks × $0.01 = $72,688.72 — a real reference_tick from the live chain.
    reference_tick: 7_268_872,
    settlement: { settlement_price: String(72_648n * SCALE) },
    ...over,
  } as V2MarketState;
}

describe('settledOutcome', () => {
  it('resolves a round that closed BELOW its line as down', () => {
    const out = settledOutcome(market(), state());
    expect(out).not.toBeNull();
    expect(out!.line).toBeCloseTo(72_688.72, 2);
    expect(out!.settlement).toBeCloseTo(72_648, 2);
    expect(out!.up).toBe(false);
  });

  it('resolves a round that closed ABOVE its line as up', () => {
    const out = settledOutcome(market(), state({ settlement: { settlement_price: String(72_700n * SCALE) } }));
    expect(out!.up).toBe(true);
  });

  it('counts settling exactly ON the line as up, matching the contract', () => {
    // The chain pays UP when settlement is at or above the strike, so a tape that
    // called this one DOWN would contradict the payout the trader actually got.
    const out = settledOutcome(market(), state({ settlement: { settlement_price: String(7_268_872n * (SCALE / 100n)) } }));
    expect(out!.settlement).toBeCloseTo(72_688.72, 2);
    expect(out!.up).toBe(true);
  });

  it('leaves out an expired round that has not settled yet', () => {
    expect(settledOutcome(market(), state({ settlement: null }))).toBeNull();
    expect(settledOutcome(market(), null)).toBeNull();
    expect(settledOutcome(market(), undefined)).toBeNull();
  });

  it('leaves out a round with no pinned line rather than guessing one', () => {
    // The ATM fallback needs a live forward, which a finished round no longer has —
    // resolving it anyway would report an outcome against a line nobody bet against.
    expect(settledOutcome(market(), state({ reference_tick: null }))).toBeNull();
  });

  it('carries the market id and expiry through, so the tape can order and key itself', () => {
    const out = settledOutcome(market({ expiry_market_id: '0xabc', expiry: 42 }), state());
    expect(out!.marketId).toBe('0xabc');
    expect(out!.expiry).toBe(42);
  });
});

describe('pickHistoryRounds', () => {
  const MIN = 60_000;
  /** A midnight, so it sits on the 1-minute, 5-minute and hourly grid at once. Cadence is
   *  read off the expiry (the longest ladder that divides it), so fixtures have to be
   *  aligned the way the scheduler aligns real markets. */
  const NOW = 19_675 * 86_400_000; // 2023-11-14T00:00:00Z

  /** A finished round expiring `agoMin` minutes before NOW. */
  function round(id: string, tenorMin: number, agoMin: number): V2Market {
    const expiry = NOW - agoMin * MIN;
    return {
      expiry_market_id: id,
      expiry,
      checkpoint_timestamp_ms: expiry - tenorMin * MIN,
      tick_size: TICK,
      admission_tick_size: TICK,
      max_expiry_allocation: '0',
    } as V2Market;
  }

  // 1-minute rounds must land on minutes that are NOT multiples of five, or they would be
  // 5-minute markets — which is not a fixture detail but how the venue works: one market
  // serves every ladder its expiry divides into.
  const notFive = (i: number) => i + 1 + Math.floor(i / 4); // 1,2,3,4,6,7,8,9,11,…
  const oneMin = (n: number) => Array.from({ length: n }, (_, i) => round(`m${i}`, 3, notFive(i)));
  const fiveMin = (n: number) => Array.from({ length: n }, (_, i) => round(`f${i}`, 15, (i + 1) * 5));

  it('returns the asked-for cadence when it has enough history', () => {
    const got = pickHistoryRounds([...oneMin(8), ...fiveMin(6)], '5m', NOW, 10);
    expect(got.from).toBe('5m');
    expect(got.picked).toHaveLength(6);
  });

  it('newest first, so the caller can cap to the most recent rounds', () => {
    const got = pickHistoryRounds(oneMin(20), '1m', NOW, 5);
    expect(got.picked).toHaveLength(5);
    expect(got.picked[0].expiry).toBeGreaterThan(got.picked[4].expiry);
  });

  it('never includes a round that has not finished yet', () => {
    const live = round('live', 3, -2); // expires two minutes from now
    const got = pickHistoryRounds([live, ...oneMin(5)], '1m', NOW, 10);
    expect(got.picked.map((m) => m.expiry_market_id)).not.toContain('live');
  });

  it('falls back to 1-minute for the hourly tab, which has no history of its own', () => {
    // The live chain confirms this: the markets walk holds dozens of finished 1m rounds
    // and zero hourly ones, because only one hourly market is alive at a time.
    const got = pickHistoryRounds(oneMin(12), '1h', NOW, 10);
    expect(got.from).toBe('1m');
    expect(got.picked).toHaveLength(10);
  });

  it('reports the asked-for cadence when the fallback is also empty, rather than lying', () => {
    const got = pickHistoryRounds([], '1h', NOW, 10);
    expect(got.from).toBe('1h');
    expect(got.picked).toHaveLength(0);
  });

  it('does not fall back over a mere handful — that would relabel a usable tape', () => {
    const got = pickHistoryRounds([...fiveMin(MIN_FOR_TAPE), ...oneMin(20)], '5m', NOW, 10);
    expect(got.from).toBe('5m');
  });

  it('falls back when the cadence is one short of usable', () => {
    const got = pickHistoryRounds([...fiveMin(MIN_FOR_TAPE - 1), ...oneMin(20)], '5m', NOW, 10);
    expect(got.from).toBe('1m');
  });
});

describe('upCount', () => {
  it('counts the up rounds', () => {
    const outs = [true, false, true, true, false].map(
      (up, i) => settledOutcome(
        market({ expiry_market_id: `0x${i}` }),
        state({ settlement: { settlement_price: String((up ? 72_700n : 72_600n) * SCALE) } }),
      )!,
    );
    expect(upCount(outs)).toBe(3);
    expect(upCount([])).toBe(0);
  });
});
