import { describe, it, expect } from 'vitest';
import { filterSkewEvents } from './v2-onchain-events';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const CODE = '0xcode';
const ev = (o: Partial<V2OrderEvent>): V2OrderEvent => o as V2OrderEvent;

describe('filterSkewEvents', () => {
  it('keeps only mints carrying our builder code plus the redeems that close them', () => {
    const all: V2OrderEvent[] = [
      ev({ kind: 'order_minted', owner: '0xa', builder_code_id: CODE, position_root_id: 'r1' }),
      ev({ kind: 'order_minted', owner: '0xb', builder_code_id: '0xother', position_root_id: 'r2' }),
      ev({ kind: 'order_minted', owner: '0xc', position_root_id: 'r3' }), // direct mint, no code
      ev({ kind: 'settled_order_redeemed', owner: '0xa', position_root_id: 'r1' }), // closes ours → keep
      ev({ kind: 'live_order_redeemed', owner: '0xb', position_root_id: 'r2' }), // closes a non-Skew mint → drop
      ev({ kind: 'liquidated_order_redeemed', owner: '0xz', position_root_id: 'rX' }), // orphan → drop
    ];
    const kept = filterSkewEvents(all, CODE).map((e) => `${e.kind}:${e.position_root_id}`);
    expect(kept).toEqual(['order_minted:r1', 'settled_order_redeemed:r1']);
  });

  it('matches Skew roots regardless of scan order (redeem paged before its mint)', () => {
    const all: V2OrderEvent[] = [
      ev({ kind: 'settled_order_redeemed', owner: '0xa', position_root_id: 'r1' }),
      ev({ kind: 'order_minted', owner: '0xa', builder_code_id: CODE, position_root_id: 'r1' }),
    ];
    expect(filterSkewEvents(all, CODE)).toHaveLength(2);
  });

  it('is empty when no bet carried the code', () => {
    const all = [ev({ kind: 'order_minted', builder_code_id: '0xnope', position_root_id: 'r' })];
    expect(filterSkewEvents(all, CODE)).toEqual([]);
  });
});
