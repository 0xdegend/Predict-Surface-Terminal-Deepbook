import { describe, it, expect } from 'vitest';
import { aggregateV2Leaderboard, emptyLbState, foldOrderEvents, finalizeRows } from './v2-aggregate';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const NOW = 10_000_000;
const CODE = '0xcode';

const mint = (o: Partial<V2OrderEvent> = {}): V2OrderEvent => ({
  kind: 'order_minted', owner: '0xA', expiry_market_id: '0xm', position_root_id: 'r1',
  net_premium: '5000000', quantity: '10000000', checkpoint_timestamp_ms: NOW, ...o,
});
const settled = (o: Partial<V2OrderEvent> = {}): V2OrderEvent => ({
  kind: 'settled_order_redeemed', owner: '0xA', expiry_market_id: '0xm', position_root_id: 'r1',
  quantity_closed: '10000000', payout_amount: '8000000', checkpoint_timestamp_ms: NOW, ...o,
});

/** The indexer's whole promise: folding events across SEPARATE cycles must equal
 *  folding them all at once (the tested batch aggregator). */
describe('incremental fold === batch aggregate', () => {
  it('mint in one cycle, redeem in a later cycle → same rows as one batch', () => {
    const s = emptyLbState();
    foldOrderEvents(s, [mint()], CODE); // cycle 1
    foldOrderEvents(s, [settled()], CODE); // cycle 2 (redeem joins the persisted mint)
    const incremental = finalizeRows(s, CODE, NOW, 'all');

    const batch = aggregateV2Leaderboard(new Map([['0xm', [mint(), settled()]]]), CODE, NOW);
    expect(incremental).toEqual(batch);
    expect(incremental[0].netPnl).toBeCloseTo(3, 6); // $8 − $5
  });

  it('many small cycles === one big batch (mixed owners + a loss + still-open)', () => {
    const events: V2OrderEvent[] = [
      mint({ owner: '0xA', position_root_id: 'a', net_premium: '5000000', builder_code_id: CODE }),
      settled({ owner: '0xA', position_root_id: 'a', payout_amount: '8000000' }),
      mint({ owner: '0xB', position_root_id: 'b', net_premium: '4000000' }),
      settled({ owner: '0xB', position_root_id: 'b', payout_amount: '0' }), // full loss
      mint({ owner: '0xC', position_root_id: 'c', net_premium: '9000000', checkpoint_timestamp_ms: NOW - 86_400_000 }), // still open, held 1d
    ];
    // Fold one event per cycle.
    const s = emptyLbState();
    for (const e of events) foldOrderEvents(s, [e], CODE);
    const incremental = finalizeRows(s, CODE, NOW, 'all');
    const batch = aggregateV2Leaderboard(new Map([['0xm', events]]), CODE, NOW);
    expect(incremental).toEqual(batch);
  });

  it('skew scope counts only builder-code-attributed activity', () => {
    const s = emptyLbState();
    foldOrderEvents(
      s,
      [
        mint({ owner: '0xA', position_root_id: 'a', net_premium: '5000000', builder_code_id: CODE }),
        mint({ owner: '0xA', position_root_id: 'a2', net_premium: '7000000' }), // NOT attributed
      ],
      CODE,
    );
    const all = finalizeRows(s, CODE, NOW, 'all');
    const skew = finalizeRows(s, CODE, NOW, 'skew');
    expect(all[0].volume).toBeCloseTo(12, 6); // 5 + 7
    expect(all[0].trades).toBe(2);
    expect(skew[0].volume).toBeCloseTo(5, 6); // only the attributed $5
    expect(skew[0].trades).toBe(1);
  });

  it('a redeem whose mint was never folded still adds no phantom cost basis', () => {
    const s = emptyLbState();
    foldOrderEvents(s, [settled({ owner: '0xghost', position_root_id: 'g', payout_amount: '9000000' })], CODE);
    // No mint → trades 0 → omitted (matches batch's redeem-only omission).
    expect(finalizeRows(s, CODE, NOW, 'all')).toEqual([]);
  });
});
