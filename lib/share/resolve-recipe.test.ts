import { describe, it, expect } from 'vitest';
import { resolveRecipe, SHARE_MIN_RUNWAY_MS } from './resolve-recipe';
import type { TradeRecipe } from './trade-link';
import type { V2Market } from '@/lib/api/v2/types';

/** A midnight, so it lies on the 1-minute, 5-minute and hourly grid at once. Cadence is
 *  a function of the expiry (the longest ladder whose period divides it), so a fixture
 *  has to be aligned the way the scheduler aligns real markets. */
const NOW = 19_675 * 86_400_000; // 2023-11-14T00:00:00Z

/** A V2Market with sane defaults; override only what a test cares about. */
function mkMarket(o: Partial<V2Market> & { expiry_market_id: string }): V2Market {
  return {
    pool_vault_id: 'vault',
    propbook_underlying_id: 0,
    expiry: NOW + 60_000,
    checkpoint_timestamp_ms: NOW + 60_000 - 180_000,
    tick_size: '10000000',
    admission_tick_size: '1000000000', // $1 grid
    max_expiry_allocation: '50000000000',
    initial_expiry_cash: '10000000000',
    liquidation_ltv: 850_000_000,
    max_admission_leverage: 3_000_000_000, // 3x
    backing_buffer_lambda: 0,
    base_fee: '0',
    min_fee: '0',
    min_entry_probability: '10000000',
    max_entry_probability: '990000000',
    expiry_fee_window_ms: 0,
    expiry_fee_max_multiplier: 0,
    trading_loss_rebate_rate: 0,
    kind: 'market_created',
    ...o,
  };
}

// Each family sits on its own grid. The 1-minute helper keeps the requested runway to
// the second, because the runway rules are what most of these tests are about; the longer
// families round UP to their next boundary, so `secsLeft` there is a floor rather than an
// exact figure — those tests only need the market to be live and pickable.
const snapUp = (ms: number, grid: number) => Math.ceil(ms / grid) * grid;

const oneM = (id: string, secsLeft: number, over: Partial<V2Market> = {}) => {
  const expiry = NOW + secsLeft * 1000;
  return mkMarket({ expiry_market_id: id, expiry, checkpoint_timestamp_ms: expiry - 180_000, ...over });
};
const fiveM = (id: string, secsLeft: number, over: Partial<V2Market> = {}) => {
  const expiry = snapUp(NOW + secsLeft * 1000, 300_000);
  return mkMarket({ expiry_market_id: id, expiry, checkpoint_timestamp_ms: expiry - 900_000, ...over });
};
const oneH = (id: string, secsLeft: number, over: Partial<V2Market> = {}) => {
  const expiry = snapUp(NOW + secsLeft * 1000, 3_600_000);
  return mkMarket({
    expiry_market_id: id,
    expiry,
    checkpoint_timestamp_ms: expiry - 3 * 3_600_000,
    max_expiry_allocation: '250000000000',
    ...over,
  });
};

const binary = (over: Partial<TradeRecipe> = {}): TradeRecipe => ({
  v: 1,
  tenor: '1m',
  mode: 'binary',
  isUp: true,
  strike: 91480,
  stake: 50,
  lev: 2,
  ...over,
});

describe('resolveRecipe — market selection', () => {
  it('resolves a binary recipe onto the current 1m market', () => {
    const res = resolveRecipe(binary(), [oneM('1m-a', 120)], NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade).toMatchObject({ marketId: '1m-a', mode: 'binary', isUp: true, strike: 91480, lev: 2 });
    expect(res.trade.adjustments).toEqual([]);
  });

  it('skips a market too close to expiry and picks the next of that tenor', () => {
    const res = resolveRecipe(binary(), [oneM('1m-soon', 2), oneM('1m-ok', 120)], NOW);
    expect(res.ok && res.trade.marketId).toBe('1m-ok');
  });

  it('picks the soonest when several of the tenor are live', () => {
    const res = resolveRecipe(binary(), [oneM('later', 180), oneM('sooner', 90)], NOW);
    expect(res.ok && res.trade.marketId).toBe('sooner');
  });

  it('returns no_market when nothing is mintable', () => {
    expect(resolveRecipe(binary(), [], NOW)).toEqual({ ok: false, reason: 'no_market' });
    expect(resolveRecipe(binary(), [oneM('too-soon', 2)], NOW)).toEqual({ ok: false, reason: 'no_market' });
    expect(resolveRecipe(binary(), [oneM('expired', -10)], NOW)).toEqual({ ok: false, reason: 'no_market' });
  });

  it('falls back to another tenor with a note when the requested one is absent', () => {
    const res = resolveRecipe(binary({ tenor: '5m' }), [oneM('1m-a', 120)], NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.marketId).toBe('1m-a');
    expect(res.trade.adjustments[0]).toMatch(/No live 5m market/i);
  });

  it('honours the requested tenor when multiple families are live', () => {
    const res = resolveRecipe(binary({ tenor: '1h' }), [oneM('1m-a', 120), fiveM('5m-a', 120), oneH('1h-a', 300)], NOW);
    expect(res.ok && res.trade.marketId).toBe('1h-a');
    expect(res.ok && res.trade.adjustments).toEqual([]);
  });
});

describe('resolveRecipe — share runway gate', () => {
  it('requires a one-minute minimum runway', () => {
    expect(SHARE_MIN_RUNWAY_MS).toBe(60_000);
  });

  it('skips a market with under a minute left for one with real runway', () => {
    // 30s is well past the few-second too-close guard, but too short for a recipient to
    // connect and confirm, so a shared link should not open onto it.
    const res = resolveRecipe(binary(), [oneM('1m-30s', 30), oneM('1m-90s', 90)], NOW);
    expect(res.ok && res.trade.marketId).toBe('1m-90s');
  });

  it('returns no_market when nothing on the board has a usable minute left', () => {
    // One nearly-over market and one already gone. Deliberately NOT a short 1-minute
    // market plus a short 5-minute one: a market is keyed by its expiry alone, so when a
    // 5-minute expiry is under a minute away it IS the 1-minute market, the same object.
    // That pair cannot exist at one instant on a real board.
    const now = NOW + 15_000; // 45s before the next minute boundary
    const res = resolveRecipe(binary(), [oneM('1m-45s-left', 60), oneM('1m-gone', 0)], now);
    expect(res).toEqual({ ok: false, reason: 'no_market' });
  });
});

describe('resolveRecipe — leverage', () => {
  it('clamps leverage to the market max and notes it', () => {
    const res = resolveRecipe(binary({ lev: 5 }), [oneM('1m-a', 120)], NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.lev).toBe(3);
    expect(res.trade.adjustments).toContain("Leverage set to this market's max of 3x.");
  });
});

describe('resolveRecipe — strike / band snapping', () => {
  it('leaves an omitted strike null (follow ATM)', () => {
    const res = resolveRecipe(binary({ strike: undefined }), [oneM('1m-a', 120)], NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.strike).toBeNull();
    expect(res.trade.adjustments).toEqual([]);
  });

  it('does not warn for negligible sub-dollar snapping on the $1 grid', () => {
    const res = resolveRecipe(binary({ strike: 91480.4 }), [oneM('1m-a', 120)], NOW);
    expect(res.ok && res.trade.strike).toBe(91480);
    expect(res.ok && res.trade.adjustments).toEqual([]);
  });

  it('snaps a strike to a coarse grid and notes the move', () => {
    const res = resolveRecipe(binary({ strike: 91480 }), [oneM('1m-a', 120, { admission_tick_size: '100000000000' })], NOW); // $100 grid
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.strike).toBe(91500);
    expect(res.trade.adjustments.some((a) => /Strike moved to \$91,500/.test(a))).toBe(true);
  });

  it('snaps a range band and keeps lower < higher', () => {
    const recipe: TradeRecipe = { v: 1, tenor: '1m', mode: 'range', lower: 91480, higher: 92030, stake: 25, lev: 1 };
    const res = resolveRecipe(recipe, [oneM('1m-a', 120, { admission_tick_size: '100000000000' })], NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade).toMatchObject({ lower: 91500, higher: 92000 });
    expect(res.trade.adjustments.some((a) => /Range moved/.test(a))).toBe(true);
  });

  it('widens a band whose edges snap to the same tick', () => {
    const recipe: TradeRecipe = { v: 1, tenor: '1m', mode: 'range', lower: 91480, higher: 91490, stake: 25, lev: 1 };
    const res = resolveRecipe(recipe, [oneM('1m-a', 120, { admission_tick_size: '100000000000' })], NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.lower).toBe(91500);
    expect(res.trade.higher).toBe(91600);
    expect(res.trade.adjustments.some((a) => /widened/.test(a))).toBe(true);
  });
});
