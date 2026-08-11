import { describe, it, expect } from 'vitest';
import { aggregateV2Leaderboard } from './v2-aggregate';
import { POINTS_RATES } from '@/lib/points/score';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const NOW = 10_000_000;
const BUILDER = '0xbuildercode';

const mint = (o: Partial<V2OrderEvent> = {}): V2OrderEvent => ({
  kind: 'order_minted',
  owner: '0xA',
  expiry_market_id: '0xm',
  position_root_id: 'r1',
  net_premium: '5000000', // $5
  quantity: '10000000', // 10 contracts
  checkpoint_timestamp_ms: NOW,
  ...o,
});

const settledRedeem = (o: Partial<V2OrderEvent> = {}): V2OrderEvent => ({
  kind: 'settled_order_redeemed',
  owner: '0xA',
  expiry_market_id: '0xm',
  position_root_id: 'r1',
  quantity_closed: '10000000',
  payout_amount: '8000000', // $8 terminal payout
  checkpoint_timestamp_ms: NOW,
  ...o,
});

const byMarket = (...orders: V2OrderEvent[]) => new Map([['0xm', orders]]);

describe('aggregateV2Leaderboard', () => {
  it('scores volume + performance with the shared Points formula', () => {
    // One $5 mint, settled for $8 → netPnl +3. Same-ms open/close ⇒ no holding.
    const rows = aggregateV2Leaderboard(byMarket(mint(), settledRedeem()), BUILDER, NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.owner).toBe('0xA');
    expect(r.volume).toBeCloseTo(5, 6);
    expect(r.trades).toBe(1);
    expect(r.netPnl).toBeCloseTo(3, 6);
    // points = 5·perDusdcVolume + 3·perDusdcProfit + 0·holding.
    const expected = 5 * POINTS_RATES.perDusdcVolume + 3 * POINTS_RATES.perDusdcProfit;
    expect(r.points).toBeCloseTo(expected, 6);
  });

  it('a live close nets its fees; a liquidation pays nothing', () => {
    const live = aggregateV2Leaderboard(
      byMarket(
        mint({ position_root_id: 'L' }),
        { kind: 'live_order_redeemed', owner: '0xA', position_root_id: 'L', quantity_closed: '10000000', redeem_amount: '7000000', trading_fee: '100000', checkpoint_timestamp_ms: NOW } as V2OrderEvent,
      ),
      BUILDER,
      NOW,
    );
    expect(live[0].netPnl).toBeCloseTo(7 - 0.1 - 5, 6); // 6.9 payout − 5 cost = +1.9

    const liq = aggregateV2Leaderboard(
      byMarket(
        mint({ position_root_id: 'K' }),
        { kind: 'liquidated_order_redeemed', owner: '0xA', position_root_id: 'K', quantity_closed: '10000000', checkpoint_timestamp_ms: NOW } as V2OrderEvent,
      ),
      BUILDER,
      NOW,
    );
    expect(liq[0].netPnl).toBeCloseTo(-5, 6); // full loss
  });

  it('floors performance at zero — a losing trader still scores on volume', () => {
    const rows = aggregateV2Leaderboard(
      byMarket(mint({ position_root_id: 'X' }), settledRedeem({ position_root_id: 'X', payout_amount: '0' })),
      BUILDER,
      NOW,
    );
    expect(rows[0].netPnl).toBeCloseTo(-5, 6);
    expect(rows[0].points).toBeCloseTo(5 * POINTS_RATES.perDusdcVolume, 6); // volume only, no negative
    expect(rows[0].losses).toBe(1); // zero-payout settled close = a loss
    expect(rows[0].wins).toBe(0);
  });

  it('counts wins and losses per resolved close (payout beat cost = win)', () => {
    const rows = aggregateV2Leaderboard(
      byMarket(
        // win: settled $8 > $5 cost
        mint({ position_root_id: 'W' }), settledRedeem({ position_root_id: 'W', payout_amount: '8000000' }),
        // loss: settled $0 (out-of-the-money, redeemed at zero by the keeper)
        mint({ position_root_id: 'X' }), settledRedeem({ position_root_id: 'X', payout_amount: '0' }),
        // win: live close nets $6.9 > $5 cost
        mint({ position_root_id: 'L' }),
        { kind: 'live_order_redeemed', owner: '0xA', position_root_id: 'L', quantity_closed: '10000000', redeem_amount: '7000000', trading_fee: '100000', checkpoint_timestamp_ms: NOW } as V2OrderEvent,
        // loss: liquidation pays nothing
        mint({ position_root_id: 'K' }),
        { kind: 'liquidated_order_redeemed', owner: '0xA', position_root_id: 'K', quantity_closed: '10000000', checkpoint_timestamp_ms: NOW } as V2OrderEvent,
      ),
      BUILDER,
      NOW,
    );
    expect(rows[0].wins).toBe(2);
    expect(rows[0].losses).toBe(2);
  });

  it('credits holding time for a position still open at now', () => {
    const oneDayAgo = NOW - 86_400_000;
    const rows = aggregateV2Leaderboard(byMarket(mint({ checkpoint_timestamp_ms: oneDayAgo })), BUILDER, NOW);
    // held 1 day, $5 cost → 5 dusdc·days · perDusdcDayHeld.
    const holding = 5 * 1 * POINTS_RATES.perDusdcDayHeld;
    expect(rows[0].points).toBeCloseTo(5 * POINTS_RATES.perDusdcVolume + holding, 5);
  });

  it('ranks by points desc and tags Skew-attributed traders', () => {
    const orders = [
      // 0xBIG — bigger volume, through the app (builder code).
      mint({ owner: '0xBIG', position_root_id: 'b', net_premium: '20000000', builder_code_id: BUILDER }),
      // 0xsm — smaller, direct (no builder code).
      mint({ owner: '0xsm', position_root_id: 's', net_premium: '4000000' }),
    ];
    const rows = aggregateV2Leaderboard(byMarket(...orders), BUILDER, NOW);
    expect(rows.map((r) => r.owner)).toEqual(['0xBIG', '0xsm']); // points desc (volume)
    const big = rows.find((r) => r.owner === '0xBIG')!;
    expect(big.viaSkew).toBe(true);
    expect(big.skewVolume).toBeCloseTo(20, 6);
    expect(rows.find((r) => r.owner === '0xsm')!.viaSkew).toBe(false);
  });

  it('omits redeem-only owners (their mint scrolled out of the window)', () => {
    const rows = aggregateV2Leaderboard(
      byMarket({ kind: 'settled_order_redeemed', owner: '0xghost', position_root_id: 'g', payout_amount: '9000000', checkpoint_timestamp_ms: NOW } as V2OrderEvent),
      BUILDER,
      NOW,
    );
    expect(rows).toEqual([]);
  });
});
