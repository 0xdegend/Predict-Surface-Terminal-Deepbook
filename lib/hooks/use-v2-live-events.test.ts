import { describe, it, expect } from 'vitest';
import { eventRefreshTargets } from './use-v2-live-events';
import { unwrapValue, normalizeLiveEvent, type LiveEvent } from '@/lib/sui/v2/event-stream';
import { qkV2 } from '@/lib/api/v2/client';

// A google.protobuf.Value as the raw subscription delivers it (kind oneof).
const strV = (s: string) => ({ kind: { oneofKind: 'stringValue', stringValue: s } });
const structV = (fields: Record<string, unknown>) => ({
  kind: { oneofKind: 'structValue', structValue: { fields } },
});

describe('event-stream normalization', () => {
  it('unwraps a nested protobuf Value struct to a plain object', () => {
    const v = structV({ expiry_market_id: strV('0xmkt'), account_id: strV('0xacct') });
    expect(unwrapValue(v)).toEqual({ expiry_market_id: '0xmkt', account_id: '0xacct' });
  });

  it('normalizes a frame into {type,module,struct,json,seq} and strips type args', () => {
    const e = normalizeLiveEvent({
      event: {
        eventType: '0xpkg::order_events::OrderMinted',
        json: structV({ expiry_market_id: strV('0xmkt'), account_id: strV('0xacct') }),
        checkpoint: 42n,
      },
    });
    expect(e).toMatchObject({ module: 'order_events', struct: 'OrderMinted', seq: 42 });
    expect(e?.json).toMatchObject({ expiry_market_id: '0xmkt', account_id: '0xacct' });
  });

  it('returns null for a watermark-only frame (no event)', () => {
    expect(normalizeLiveEvent({})).toBeNull();
  });

  it('strips generic type arguments from the struct name', () => {
    const e = normalizeLiveEvent({ event: { eventType: '0xp::oracle_lane::ObservationRecorded<0xp::x::Y>' } });
    expect(e?.struct).toBe('ObservationRecorded');
  });
});

const ev = (module: string, json: Record<string, unknown>): LiveEvent => ({
  type: `0xpkg::${module}::X`,
  module,
  struct: 'X',
  json,
  seq: 1,
});

describe('eventRefreshTargets', () => {
  it('order event → the ONE named market + account + the aggregate board, never a fan-out', () => {
    const keys = eventRefreshTargets(ev('order_events', { expiry_market_id: '0xmkt', account_id: '0xacct' }));
    const flat = keys.map((k) => k.join('|'));
    expect(flat).toContain(qkV2.marketOpenInterest('0xmkt').join('|'));
    expect(flat).toContain(qkV2.marketOrders('0xmkt').join('|'));
    expect(flat).toContain(qkV2.accountPositions('0xacct').join('|'));
    // The settled-value reconciliation (prefix key) so a keeper auto-redeem drops the
    // resolved position near-instantly, not on that query's interval.
    expect(flat).toContain(['v2', 'settled-order-value', '0xacct'].join('|'));
    expect(flat).toContain(['v2', 'leaderboard', 'boards'].join('|'));
    // Only ONE market's OI is ever targeted (no other market ids leak in).
    expect(flat.filter((k) => k.includes('open-interest'))).toHaveLength(1);
  });

  it('order event with no ids still refreshes the board, nothing per-market', () => {
    const keys = eventRefreshTargets(ev('order_events', {}));
    const flat = keys.map((k) => k.join('|'));
    expect(flat).toEqual([['v2', 'leaderboard', 'boards'].join('|')]);
  });

  it('vault event → the vault surfaces only', () => {
    const flat = eventRefreshTargets(ev('vault_events', {})).map((k) => k.join('|'));
    expect(flat).toContain(qkV2.vaultServerState.join('|'));
    expect(flat).toContain(qkV2.vaultFlushes.join('|'));
    expect(flat.some((k) => k.includes('open-interest'))).toBe(false);
  });

  it('builder-code event → that code’s fees; unknown modules → nothing', () => {
    expect(eventRefreshTargets(ev('builder_code_events', { builder_code_id: '0xcode' })).map((k) => k.join('|')))
      .toContain(qkV2.builderCodeFees('0xcode').join('|'));
    expect(eventRefreshTargets(ev('config_events', {}))).toHaveLength(0);
  });
});
