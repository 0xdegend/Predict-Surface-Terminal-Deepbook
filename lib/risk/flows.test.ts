import { describe, it, expect } from 'vitest';
import { mergeVaultFlows } from './flows';
import type { LpSupplyEvent, LpWithdrawalEvent } from '@/lib/api/types';

function supply(over: Partial<LpSupplyEvent>): LpSupplyEvent {
  return {
    event_digest: '', digest: 'd', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', predict_id: '0xp',
    supplier: '0xS', quote_asset: 'DUSDC', amount: 0, shares_minted: 0,
    ...over,
  };
}
function withdrawal(over: Partial<LpWithdrawalEvent>): LpWithdrawalEvent {
  return {
    event_digest: '', digest: 'd', sender: '', checkpoint: 0, checkpoint_timestamp_ms: 0,
    tx_index: 0, event_index: 0, package: '', predict_id: '0xp',
    withdrawer: '0xW', quote_asset: 'DUSDC', amount: 0, shares_burned: 0,
    ...over,
  };
}

describe('mergeVaultFlows', () => {
  it('folds supplies + withdrawals into one newest-first tape', () => {
    const flows = mergeVaultFlows(
      [supply({ checkpoint_timestamp_ms: 10, amount: 100, shares_minted: 99 })],
      [withdrawal({ checkpoint_timestamp_ms: 20, amount: 50, shares_burned: 50 })],
    );
    expect(flows.map((f) => f.kind)).toEqual(['out', 'in']); // ts 20 before ts 10
    expect(flows[0]).toMatchObject({ kind: 'out', account: '0xW', amount: 50, shares: 50 });
    expect(flows[1]).toMatchObject({ kind: 'in', account: '0xS', amount: 100, shares: 99 });
  });

  it('caps the tape at the limit', () => {
    const supplies = Array.from({ length: 30 }, (_, i) => supply({ checkpoint_timestamp_ms: i }));
    expect(mergeVaultFlows(supplies, [], 10)).toHaveLength(10);
  });

  it('returns an empty tape when there are no flows', () => {
    expect(mergeVaultFlows([], [])).toEqual([]);
  });
});
