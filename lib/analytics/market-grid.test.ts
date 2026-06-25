import { describe, it, expect } from 'vitest';
import {
  buildMarketGrid,
  nearestGridStrike,
  openInterestByOracle,
  metricValue,
  metricIntensities,
  type MarketInput,
} from './market-grid';
import { FLOAT_SCALING } from '@/config/scale';
import type { SviFloat } from '@/lib/svi/svi';
import type { Oracle, PositionMintedEvent, PositionRedeemedEvent } from '@/lib/api/types';

const Q = 1_000_000; // @6dec → 1 DUSDC
const E9 = FLOAT_SCALING;
const SVI: SviFloat = { a: 0.0004, b: 0.001, rho: -0.2, m: 0, sigma: 0.05 };

function oracle(over: Partial<Oracle> = {}): Oracle {
  return {
    predict_id: '0xp', oracle_id: '0xA', oracle_cap_id: '', underlying_asset: 'BTC',
    expiry: 1_000_000, min_strike: 50_000 * E9, tick_size: 1 * E9, status: 'active',
    activated_at: 0, settlement_price: null, settled_at: null, created_checkpoint: 0,
    ...over,
  };
}

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

describe('nearestGridStrike', () => {
  it('snaps a forward to the closest $1 grid strike (exact scaled int)', () => {
    const { strike, strikeScaled } = nearestGridStrike(oracle(), 63_400.7);
    expect(strike).toBe(63_401); // rounds to nearest tick
    expect(strikeScaled).toBe(String(63_401 * E9));
  });

  it('clamps below the grid floor', () => {
    const { strike } = nearestGridStrike(oracle(), 10_000);
    expect(strike).toBe(50_000); // min strike
  });
});

describe('openInterestByOracle', () => {
  it('nets minted minus redeemed quantity per oracle', () => {
    const m = [minted({ oracle_id: '0xA', quantity: 10 * Q }), minted({ oracle_id: '0xB', quantity: 4 * Q })];
    const r = [redeemed({ oracle_id: '0xA', quantity: 3 * Q })];
    const oi = openInterestByOracle(m, r);
    expect(oi.get('0xA')).toBeCloseTo(7);
    expect(oi.get('0xB')).toBeCloseTo(4);
  });
});

describe('buildMarketGrid', () => {
  const inputs: MarketInput[] = [
    { oracle: oracle({ oracle_id: '0xA', expiry: 2000 }), svi: SVI, forward: 63_000 },
    { oracle: oracle({ oracle_id: '0xB', expiry: 1000 }), svi: SVI, forward: 63_000 },
  ];

  it('joins flow + OI + sentiment per active oracle and sorts by expiry', () => {
    const m = [
      minted({ oracle_id: '0xA', cost: 5 * Q, quantity: 5 * Q, is_up: true }),
      minted({ oracle_id: '0xA', cost: 1 * Q, quantity: 1 * Q, is_up: false }),
    ];
    const r = [redeemed({ oracle_id: '0xA', quantity: 2 * Q })];
    const cells = buildMarketGrid(inputs, m, r, 0);

    expect(cells.map((c) => c.oracleId)).toEqual(['0xB', '0xA']); // sorted by expiry asc
    const a = cells.find((c) => c.oracleId === '0xA')!;
    expect(a.volume).toBeCloseTo(6);
    expect(a.trades).toBe(2);
    expect(a.openInterest).toBeCloseTo(4); // (5+1) minted − 2 redeemed
    expect(a.upShare).toBeCloseTo(5 / 6);
    expect(a.atmIv).toBeGreaterThan(0);
    expect(a.atmStrike).toBe(63_000); // ATM snapped to forward
  });

  it('defaults a market with no flow to neutral / zero', () => {
    const b = buildMarketGrid(inputs, [], [], 0).find((c) => c.oracleId === '0xB')!;
    expect(b.volume).toBe(0);
    expect(b.openInterest).toBe(0);
    expect(b.upShare).toBe(0.5);
  });
});

describe('metric coloring', () => {
  const cells = buildMarketGrid(
    [
      { oracle: oracle({ oracle_id: '0xA' }), svi: SVI, forward: 63_000 },
      { oracle: oracle({ oracle_id: '0xB' }), svi: SVI, forward: 63_000 },
    ],
    [minted({ oracle_id: '0xA', cost: 10 * Q, quantity: 10 * Q })],
    [],
    0,
  );

  it('sentiment metric is distance from neutral', () => {
    const a = cells.find((c) => c.oracleId === '0xA')!; // all UP → one-sided
    expect(metricValue(a, 'sentiment')).toBeCloseTo(1);
  });

  it('normalizes intensities against the hottest cell', () => {
    const it = metricIntensities(cells, 'volume');
    expect(it.get('0xA')).toBeCloseTo(1); // the only market with volume
    expect(it.get('0xB')).toBe(0);
  });
});
