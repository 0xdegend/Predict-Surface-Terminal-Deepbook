import { describe, it, expect } from 'vitest';
import {
  normalizeV2Position,
  valueV2Position,
  settleV2Position,
  positionMarkPrice,
  positionWinPayout,
  buildV2Spark,
  deriveV2HistoryFromOrders,
  summarizePositions,
  v2EntryFees,
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

describe('settleV2Position (settled winner payout — leverage-correct)', () => {
  const base = normalizeV2Position(REAL_ROW, 0, MARKET); // 2×, qty $13.31, cost ~$5, floor ~$5, strike $64,364

  it('a 2× win pays equity ABOVE the floor (qty − floor), NOT the full qty', () => {
    const s = settleV2Position(base, 64_500); // settles above the $64,364 strike → UP wins
    expect(s.settled).toBe(true);
    expect(s.won).toBe(true);
    // payout = 13.31 − 5.0 ≈ 8.31, NOT the full 13.31 (the 154%-vs-54% overstatement)
    expect(s.markValue).toBeCloseTo(8.31, 1);
    expect(s.markValue!).toBeLessThan(base.qty);
    // PnL is NET (value − cost), not gross (value/cost)
    expect(s.pnl).toBeCloseTo(3.31, 1);
  });

  it('the settled value equals the live mark at settlement (mark = 1)', () => {
    const settledVal = settleV2Position(base, 64_500).markValue;
    const liveAtOne = valueV2Position(base, 1).markValue; // in-the-money live mark
    expect(settledVal).toBeCloseTo(liveAtOne!, 5);
  });

  it('derives the floor when floor_shares is absent (the positions feed omits it)', () => {
    const noFloor = { ...base, floorShares: undefined };
    // derived floor = entryPrice·qty·(1 − 1/L) = 0.7512·13.31·0.5 ≈ 5.0 → payout ≈ 8.31
    expect(settleV2Position(noFloor, 64_500).markValue).toBeCloseTo(8.31, 1);
  });

  it('a loss (settles below the strike) pays 0', () => {
    const s = settleV2Position(base, 60_000);
    expect(s.won).toBe(false);
    expect(s.markValue).toBe(0);
    expect(s.pnl).toBeCloseTo(-base.cost!, 5);
  });

  it('an unleveraged win pays the full qty (floor 0)', () => {
    const s = settleV2Position({ ...base, leverage: 1, floorShares: undefined }, 64_500);
    expect(s.markValue).toBeCloseTo(base.qty, 5);
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

describe('summarizePositions — openLabel names a lone open bet', () => {
  const base = normalizeV2Position(REAL_ROW, 0, MARKET);

  it('sets openLabel for exactly one open bet, even with no live PnL to rank on', () => {
    const s = summarizePositions([{ ...base, qty: 5, settled: false, pnl: undefined, markValue: undefined }]);
    expect(s.openCount).toBe(1);
    expect(s.best).toBeUndefined(); // no PnL → nothing to rank, so best/worst stay empty
    expect(s.openLabel).toBeTruthy(); // but the trade is still named
  });

  it('leaves openLabel undefined when more than one is open (best/worst take over)', () => {
    const s = summarizePositions([
      { ...base, qty: 5, settled: false },
      { ...base, qty: 5, settled: false },
    ]);
    expect(s.openCount).toBe(2);
    expect(s.openLabel).toBeUndefined();
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

/**
 * Golden test against a REAL settled claim on testnet — expiry market
 * 0x2542c65…, claim tx CusBoEJ7…. Every figure below is copied from the on-chain
 * events, so if our payout/cost rules ever drift from the protocol's, this fails.
 *
 * The two bugs it locks down:
 *  1. the position card advertised the raw notional (14.68) as "to win", but a 2×
 *     win nets out the leverage floor and the chain paid 9.680034;
 *  2. cost counted only the stake, dropping the 0.136821 mint fee, so PnL and ROI
 *     both read high (+93.60% instead of the true +88.45%).
 */
describe('golden: the 2026-07-13 settled claim (chain-verified)', () => {
  const MKT = '0x2542c6537322ee64b57770b6eda9f93a2026943070344e53d2a3c3c8fc03851b';
  const ROOT = '100433593438436434593118549792012172889945301013461314043905';
  const CHAIN_PAYOUT = 9.680034; // SettledOrderRedeemed.payout_amount = 9_680_034
  const ALL_IN_COST = 5.136787; // net_premium 4.999966 + trading_fee 0.136821

  const market = {
    expiry_market_id: MKT,
    expiry: 1783905240000,
    tick_size: '10000000', // $0.01
  } as unknown as V2Market;

  // settlement_price 63_829_945_556_340 (1e9-scaled) → above the $63,802 strike.
  const SETTLEMENT = 63829.94555634;

  // order_minted: UP $63,802 · 14.68 contracts · 2× · entry 68.1194%.
  const mint: V2OrderEvent = {
    kind: 'order_minted',
    expiry_market_id: MKT,
    position_root_id: ROOT,
    order_id: ROOT,
    lower_tick: 6380200,
    higher_tick: 1073741823, // +∞ ⇒ UP
    quantity: '14680000',
    net_premium: '4999966',
    trading_fee: '136821',
    builder_fee: '0',
    penalty_fee: '0',
    entry_probability: 681194345,
    leverage: 2000000000,
    checkpoint_timestamp_ms: 1783905206819,
  };

  const claim: V2OrderEvent = {
    kind: 'settled_order_redeemed',
    expiry_market_id: MKT,
    position_root_id: ROOT,
    order_id: ROOT,
    quantity_closed: '14680000',
    payout_amount: '9680034',
    settlement_price: '63829945556340',
    checkpoint_timestamp_ms: 1783979560830,
  };

  // The open row exactly as /accounts/{id}/positions reports it — note it carries
  // the stake but NO fee field, which is why v2EntryFees has to join the mint in.
  const row = {
    expiry_market_id: MKT,
    order_id: ROOT,
    position_root_id: ROOT,
    status: 'open',
    lower_tick: 6380200,
    higher_tick: 1073741823,
    quantity: '14680000',
    net_premium: '4999966',
    // entry_value·(1 − 1/L) = 0.681194345 × 14.68 × 0.5. The chain's payout implies
    // exactly this floor: 14.68 − 9.680034 = 4.999966.
    floor_shares: '4999966',
    entry_probability: 681194345,
    leverage: 2000000000,
    opened_at_ms: 1783905206819,
  } as unknown as V2Position;

  const enriched = () =>
    normalizeV2Position(row, 0, market, v2EntryFees([mint]).get(ROOT) ?? 0);

  it('"to win" is the notional MINUS the leverage floor — the amount the chain paid', () => {
    const p = enriched();
    expect(p.qty).toBeCloseTo(14.68, 2); // the notional the card used to advertise
    expect(positionWinPayout(p)).toBeCloseTo(CHAIN_PAYOUT, 4); // what actually lands
    expect(positionWinPayout(p)).toBeLessThan(p.qty);
  });

  it('derives the same payout when the feed omits floor_shares', () => {
    // Falls back to entry_value·(1 − 1/L) — must still land on the chain's number.
    const derived = { ...enriched(), floorShares: undefined };
    expect(positionWinPayout(derived)).toBeCloseTo(CHAIN_PAYOUT, 4);
  });

  it('cost is all-in: the stake PLUS the fee charged at mint', () => {
    expect(enriched().cost).toBeCloseTo(ALL_IN_COST, 6);
    // Without the fee join it would understate by the 0.136821 trading fee.
    expect(normalizeV2Position(row, 0, market).cost).toBeCloseTo(4.999966, 6);
  });

  it('settling the winner reproduces the chain payout and a fee-aware PnL', () => {
    const s = settleV2Position(enriched(), SETTLEMENT);
    expect(s.won).toBe(true); // 63,829.95 settled above the $63,802 strike
    expect(s.markValue).toBeCloseTo(CHAIN_PAYOUT, 4);
    expect(s.pnl).toBeCloseTo(CHAIN_PAYOUT - ALL_IN_COST, 4); // +4.543, not +4.680
  });

  it('the realized history row agrees with the claim event', () => {
    const [h] = deriveV2HistoryFromOrders([mint, claim], new Map([[MKT, market]]));
    expect(h.result).toBe('won');
    expect(h.strike).toBeCloseTo(63802, 0); // 6_380_200 ticks × $0.01
    expect(h.payout).toBeCloseTo(CHAIN_PAYOUT, 4);
    expect(h.cost).toBeCloseTo(ALL_IN_COST, 6);
    expect(h.pnl).toBeCloseTo(4.543247, 5);
    expect(h.roi).toBeCloseTo(0.8845, 3); // +88.45%, not the +93.60% the bare stake implied
  });
});
