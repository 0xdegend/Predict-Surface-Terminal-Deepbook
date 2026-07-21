import { describe, it, expect } from 'vitest';
import {
  orderSide,
  flowRows,
  sentimentFromOrders,
  marketVolumeFromOrders,
  marketCell,
  marketCells,
  kpisFromData,
} from './v2-aggregate';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

const POS_INF = 1073741823;

const mkt = (id: string, expiry: number): V2Market =>
  ({
    expiry_market_id: id,
    expiry,
    // cadenceOf reads the tenor from expiry − created; a ~1h gap → '1h'.
    checkpoint_timestamp_ms: expiry - 3_600_000,
    tick_size: '10000000',
  }) as unknown as V2Market;

// An order_minted, with sensible defaults (UP, $5 stake, 2×).
const mint = (o: Partial<V2OrderEvent> = {}): V2OrderEvent => ({
  kind: 'order_minted',
  expiry_market_id: '0xA',
  owner: '0xtrader1',
  order_id: String(Math.random()),
  checkpoint_timestamp_ms: 1_000,
  lower_tick: 6_380_200,
  higher_tick: POS_INF,
  quantity: '10000000', // 10 DUSDC notional
  net_premium: '5000000', // 5 DUSDC staked
  leverage: 2_000_000_000, // 2×
  ...o,
});

describe('orderSide', () => {
  it('reads UP / DOWN / RANGE from the tick pair', () => {
    expect(orderSide(6_380_200, POS_INF)).toBe('up'); // higher = +∞
    expect(orderSide(0, 6_380_200)).toBe('down'); // lower = 0
    expect(orderSide(6_300_000, 6_400_000)).toBe('range'); // two finite ticks
  });
});

describe('sentimentFromOrders', () => {
  it('weights UP vs DOWN by premium staked, ignoring RANGE and redeems', () => {
    const orders: V2OrderEvent[] = [
      mint({ higher_tick: POS_INF, net_premium: '30000000' }), // UP $30
      mint({ higher_tick: POS_INF, net_premium: '10000000' }), // UP $10
      mint({ lower_tick: 0, higher_tick: 6_380_200, net_premium: '20000000' }), // DOWN $20
      mint({ lower_tick: 6_300_000, higher_tick: 6_400_000, net_premium: '99000000' }), // RANGE — excluded
      { kind: 'live_order_redeemed', net_premium: '50000000' } as V2OrderEvent, // not a mint — excluded
    ];
    const s = sentimentFromOrders(orders);
    expect(s.upCost).toBeCloseTo(40, 6);
    expect(s.downCost).toBeCloseTo(20, 6);
    expect(s.upCount).toBe(2);
    expect(s.downCount).toBe(1);
    expect(s.totalCost).toBeCloseTo(60, 6);
    expect(s.upShare).toBeCloseTo(40 / 60, 6);
  });

  it('is a neutral 0.5 with no directional flow', () => {
    expect(sentimentFromOrders([]).upShare).toBe(0.5);
    expect(sentimentFromOrders([mint({ lower_tick: 6_300_000, higher_tick: 6_400_000 })]).upShare).toBe(0.5);
  });
});

describe('flowRows', () => {
  it('maps every mint to a row, newest-first, tagged with its market cadence', () => {
    const markets = [mkt('0xA', 5_000_000), mkt('0xB', 5_000_000)];
    const byMarket = new Map<string, V2OrderEvent[]>([
      ['0xA', [mint({ order_id: '1', checkpoint_timestamp_ms: 100 }), mint({ order_id: '2', checkpoint_timestamp_ms: 300 })]],
      ['0xB', [mint({ expiry_market_id: '0xB', order_id: '3', checkpoint_timestamp_ms: 200 })]],
    ]);
    const rows = flowRows(byMarket, markets);
    expect(rows.map((r) => r.id)).toEqual(['2', '3', '1']); // 300, 200, 100
    expect(rows[0].side).toBe('up');
    expect(rows[0].stakeUsd).toBeCloseTo(5, 6);
    expect(rows[0].payoutUsd).toBeCloseTo(10, 6);
    expect(rows[0].leverage).toBe(2);
    expect(rows[0].cadence).toBe('1h');
  });

  it('skips redeems and mints with no owner', () => {
    const rows = flowRows(
      new Map([['0xA', [{ kind: 'live_order_redeemed', owner: '0xx' } as V2OrderEvent, mint({ owner: undefined })]]]),
      [mkt('0xA', 5_000_000)],
    );
    expect(rows).toEqual([]);
  });
});

describe('marketVolumeFromOrders', () => {
  it('sums minted premium (DUSDC) and mint count from the orders feed', () => {
    const orders = [
      mint({ net_premium: '30000000' }), // $30
      mint({ net_premium: '12000000' }), // $12
      { kind: 'settled_order_redeemed', net_premium: '99000000' } as V2OrderEvent, // not a mint
    ];
    const { volume, bets } = marketVolumeFromOrders(orders);
    expect(volume).toBeCloseTo(42, 6);
    expect(bets).toBe(2); // redeem excluded
  });

  it('is zero for a market with no orders', () => {
    expect(marketVolumeFromOrders(undefined)).toEqual({ volume: 0, bets: 0 });
  });
});

describe('marketCell / marketCells', () => {
  const market = mkt('0xA', 5_000_000);
  // Volume + sentiment both come from the ORDERS feed now (no activity rollups).
  const inputs = {
    orders: [
      mint({ higher_tick: POS_INF, net_premium: '30000000' }), // UP $30
      mint({ lower_tick: 0, higher_tick: 6_380_200, net_premium: '10000000' }), // DOWN $10
    ],
    oi: 6,
    forward: 63_800,
    atmIv: 0.42,
  };

  it('folds a market’s feeds into a cell with real metrics', () => {
    const c = marketCell(market, inputs, 63_000);
    expect(c.volume).toBeCloseTo(40, 6); // 30 + 10 from the orders
    expect(c.bets).toBe(2);
    expect(c.oi).toBe(6);
    expect(c.forward).toBe(63_800); // pricer forward wins over spot
    expect(c.atmIv).toBe(0.42);
    expect(c.upShare).toBeCloseTo(0.75, 6); // 30 UP / 40 total
    expect(c.cadence).toBe('1h');
  });

  it('falls back to the page spot when the pricer has no forward', () => {
    expect(marketCell(market, {}, 63_000).forward).toBe(63_000);
    expect(marketCell(market, {}, null).forward).toBe(0);
  });

  it('ranks markets by volume desc', () => {
    const cells = marketCells(
      [mkt('0xA', 5_000_000), mkt('0xB', 5_000_000)],
      new Map([
        ['0xA', { orders: [mint({ net_premium: '50000000' })] }],
        ['0xB', { orders: [mint({ expiry_market_id: '0xB', net_premium: '90000000' })] }],
      ]),
      63_000,
    );
    expect(cells.map((c) => c.marketId)).toEqual(['0xB', '0xA']);
  });
});

describe('kpisFromData', () => {
  it('totals volume + biggest stake from the recent order pool (one feed)', () => {
    const orders = [
      mint({ net_premium: '5000000' }),
      mint({ net_premium: '80000000' }), // the biggest — $80
      mint({ lower_tick: 0, higher_tick: 6_380_200, net_premium: '20000000' }),
      { kind: 'settled_order_redeemed', net_premium: '99000000' } as V2OrderEvent, // ignored
    ];
    const k = kpisFromData(orders, 1);
    expect(k.totalBet).toBeCloseTo(105, 6); // 5 + 80 + 20, redeem ignored
    expect(k.activeMarkets).toBe(1);
    expect(k.biggestBet).toBeCloseTo(80, 6);
    expect(k.upShare).toBeCloseTo(85 / 105, 6); // (5+80) UP / (5+80+20)
  });
});
