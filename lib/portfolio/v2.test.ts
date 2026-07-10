import { describe, it, expect } from 'vitest';
import {
  normalizeV2Position,
  valueV2Position,
  positionMarkPrice,
  buildV2Spark,
  deriveV2HistoryFromOrders,
} from './v2';
import type { V2Position, V2Market, V2OrderEvent } from '@/lib/api/v2/types';
import type { SviFloat } from '@/lib/svi/svi';

// The real open-position row from the live indexer (2026-07-10), an UP bet:
// lower_tick 6,436,400 with a +∞ higher tick, on a $0.01-tick market.
const REAL_ROW = {
  expiry_market_id: '0x5615ed60e4f37337856d810841777d4b1b95ba566f2ba5e8782ac4096b7d1dd9',
  order_id: '100433596642048023622457747817916619191558259580338847088640',
  owner: '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4',
  status: 'open',
  lower_tick: 6436400,
  higher_tick: 1073741823, // POS_INF_TICK
  quantity: '13310000', // $13.31 max payout
  net_premium: '4998922', // ~$5.00 staked
  floor_shares: '4998922', // static floor (= net_premium at 2x)
  entry_probability: 751152891, // 0.7512
  leverage: 2000000000,
  opened_at_ms: 1783681448755,
} as unknown as V2Position;

const MARKET = {
  expiry_market_id: '0x5615ed60e4f37337856d810841777d4b1b95ba566f2ba5e8782ac4096b7d1dd9',
  expiry: 1783682400000,
  tick_size: '10000000', // $0.01 (1e9-scaled)
  admission_tick_size: '1000000000',
} as unknown as V2Market;

describe('normalizeV2Position (real indexer row)', () => {
  it('converts the strike TICK to a price via tick_size (not toFloat of the raw tick)', () => {
    const r = normalizeV2Position(REAL_ROW, 0, MARKET);
    // 6_436_400 ticks × $0.01 = $64,364 — NOT 0.0064 (raw toFloat of the tick).
    expect(r.strike).toBeCloseTo(64364, 0);
    expect(r.direction).toBe('Up');
  });

  it('maps max payout, staked cost, and entry probability from the real fields', () => {
    const r = normalizeV2Position(REAL_ROW, 0, MARKET);
    expect(r.qty).toBeCloseTo(13.31, 2); // quantity → max payout
    expect(r.cost).toBeCloseTo(5.0, 2); // net_premium → staked cost
    expect(r.entryPrice).toBeCloseTo(0.7512, 4); // entry_probability (1e9) → 0..1
    expect(r.settled).toBe(false);
    expect(r.qtyBase).toBe(13_310_000n);
    expect(r.orderId).toBe(BigInt(REAL_ROW.order_id as string));
  });

  it('without the market, leaves strike undefined rather than a wrong number', () => {
    const r = normalizeV2Position(REAL_ROW, 0, undefined);
    expect(r.strike).toBeUndefined();
    expect(r.direction).toBe('Up'); // direction still resolves from the ticks
  });

  it('carries floor_shares, leverage and opened_at for MTM + the mini tiles', () => {
    const r = normalizeV2Position(REAL_ROW, 0, MARKET);
    expect(r.floorShares).toBeCloseTo(5.0, 2); // 4_998_922 base → ~$5
    expect(r.leverage).toBe(2);
  });
});

describe('valueV2Position (client-side MTM)', () => {
  const base = normalizeV2Position(REAL_ROW, 0, MARKET); // entry 75.1%, cost ~$5, qty $13.31, floor ~$5

  it('at the entry chance, value ≈ cost and PnL ≈ 0', () => {
    const v = valueV2Position(base, 0.7512);
    // value = max(0, 0.7512·13.31 − 5.0) ≈ 5.0 ; pnl ≈ 0
    expect(v.markValue).toBeCloseTo(5.0, 1);
    expect(v.pnl).toBeCloseTo(0, 1);
    expect(v.markPrice).toBeCloseTo(0.7512, 4);
  });

  it('a favorable move raises value and PnL; net move is in points', () => {
    const v = valueV2Position(base, 0.85);
    expect(v.markValue!).toBeGreaterThan(base.cost!);
    expect(v.pnl!).toBeGreaterThan(0);
    expect(v.deltaPp!).toBeCloseTo((0.85 - 0.7512) * 100, 2);
  });

  it('below the knockout the leveraged bet is worth 0 (full loss)', () => {
    const v = valueV2Position(base, 0.2); // 0.2·13.31 − 5 = −2.3 → floored to 0
    expect(v.markValue).toBe(0);
    expect(v.pnl).toBeCloseTo(-base.cost!, 5);
  });

  it('is a no-op when there is no pricer', () => {
    expect(valueV2Position(base, null)).toBe(base);
  });
});

describe('positionMarkPrice', () => {
  const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
  it('returns the DOWN complement for a down bet', () => {
    const down = { ...normalizeV2Position(REAL_ROW, 0, MARKET), direction: 'Down' as const, strike: 64000 };
    const p = positionMarkPrice(down, { forward: 64000, svi: SVI });
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0);
    expect(p!).toBeLessThan(1);
  });
});

describe('buildV2Spark', () => {
  const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
  const pricer = { forward: 64364, svi: SVI }; // ATM at the position's strike
  // A rising BTC path over ~4 minutes (oldest → newest).
  const spots = [63000, 63400, 63800, 64100, 64364].map((s, i) => ({ t: 1000 + i * 60_000, s }));
  const openPos = normalizeV2Position(REAL_ROW, 0, MARKET);

  it('produces one probability point per spot, all in [0,1]', () => {
    const spark = buildV2Spark(openPos, pricer, spots);
    expect(spark).toHaveLength(spots.length);
    for (const v of spark) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('an UP position\'s implied chance rises as spot rises', () => {
    const spark = buildV2Spark(openPos, pricer, spots);
    expect(spark[spark.length - 1]).toBeGreaterThan(spark[0]);
  });

  it('is empty without a pricer, without history, or when settled', () => {
    expect(buildV2Spark(openPos, undefined, spots)).toEqual([]);
    expect(buildV2Spark(openPos, pricer, [])).toEqual([]);
    const settled = { ...openPos, settled: true };
    expect(buildV2Spark(settled, pricer, spots)).toEqual([]);
  });
});

describe('deriveV2HistoryFromOrders', () => {
  const MKT = MARKET.expiry_market_id;
  const mm = new Map([[MKT, MARKET]]);
  // Position P1: minted UP $64,364, $5 staked, then SETTLED in-the-money (full payout).
  const mintP1: V2OrderEvent = {
    kind: 'order_minted',
    expiry_market_id: MKT,
    position_root_id: 'P1',
    order_id: '10',
    lower_tick: 6436400,
    higher_tick: 1073741823,
    quantity: '13310000',
    net_premium: '4998922',
    entry_probability: 751152891,
    checkpoint_timestamp_ms: 1000,
  };
  const settledWin: V2OrderEvent = {
    kind: 'settled_order_redeemed',
    expiry_market_id: MKT,
    position_root_id: 'P1',
    order_id: '10',
    quantity_closed: '13310000',
    payout_amount: '13310000', // full max payout, ITM
    settlement_price: 65000000000000,
    checkpoint_timestamp_ms: 5000,
  };
  // Position P2: minted, then LIQUIDATED (knocked out) → zero payout, full loss.
  const mintP2: V2OrderEvent = { ...mintP1, position_root_id: 'P2', order_id: '20', checkpoint_timestamp_ms: 2000 };
  const liquidated: V2OrderEvent = {
    kind: 'liquidated_order_redeemed',
    expiry_market_id: MKT,
    position_root_id: 'P2',
    order_id: '20',
    quantity_closed: '13310000',
    checkpoint_timestamp_ms: 6000,
  };
  // Position P3: minted but still OPEN (no redeem event) → not history.
  const mintP3: V2OrderEvent = { ...mintP1, position_root_id: 'P3', order_id: '30' };

  it('joins redeems to their mints; open positions are excluded', () => {
    const hist = deriveV2HistoryFromOrders([mintP1, settledWin, mintP2, liquidated, mintP3], mm);
    expect(hist).toHaveLength(2); // P1 (settled) + P2 (liquidated); P3 open is skipped
  });

  it('a settled in-the-money win: payout = payout_amount, PnL = payout − cost', () => {
    const [win] = deriveV2HistoryFromOrders([mintP1, settledWin], mm);
    expect(win.result).toBe('won');
    expect(win.up).toBe(true);
    expect(win.strike).toBeCloseTo(64364, 0); // tick × tick_size
    expect(win.cost).toBeCloseTo(5.0, 2);
    expect(win.payout).toBeCloseTo(13.31, 2);
    expect(win.pnl).toBeCloseTo(8.31, 2);
    expect(win.entryPrice).toBeCloseTo(0.7512, 4);
  });

  it('a liquidation is a full loss: payout 0, PnL = −cost', () => {
    const [liq] = deriveV2HistoryFromOrders([mintP2, liquidated], mm);
    expect(liq.result).toBe('lost');
    expect(liq.payout).toBe(0);
    expect(liq.pnl).toBeCloseTo(-5.0, 2);
  });

  it('a live close nets fees off the redeem amount', () => {
    const liveClose: V2OrderEvent = {
      kind: 'live_order_redeemed',
      expiry_market_id: MKT,
      position_root_id: 'P1',
      order_id: '10',
      quantity_closed: '13310000',
      redeem_amount: '7000000', // $7.00 gross
      trading_fee: '100000', // $0.10
      builder_fee: '0',
      penalty_fee: '0',
      checkpoint_timestamp_ms: 4000,
    };
    const [row] = deriveV2HistoryFromOrders([mintP1, liveClose], mm);
    expect(row.payout).toBeCloseTo(6.9, 2); // 7.00 − 0.10 fees
    expect(row.pnl).toBeCloseTo(6.9 - 5.0, 2);
  });

  it('prorates cost basis on a partial close', () => {
    const halfClose: V2OrderEvent = {
      kind: 'settled_order_redeemed',
      expiry_market_id: MKT,
      position_root_id: 'P1',
      order_id: '10',
      quantity_closed: '6655000', // half of 13,310,000
      payout_amount: '6655000',
      checkpoint_timestamp_ms: 4000,
    };
    const [row] = deriveV2HistoryFromOrders([mintP1, halfClose], mm);
    expect(row.cost).toBeCloseTo(2.5, 2); // half of $5 staked
    expect(row.contracts).toBeCloseTo(6.655, 3);
  });
});
