/**
 * Live check for the on-chain LP queue reader. Network-gated — runs only with
 * RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/v2/lp-queue.live.test.ts
 *
 * `readLpQueues` BCS-decodes `lp_book::RequestPage` out of the vault's queue
 * Tables, so a protocol upgrade that reorders those fields would silently yield
 * garbage entries (wrong amounts, wrong cancel indices — a cancel against a wrong
 * index is real money). The reader self-checks by reconciling entry count and
 * escrow sum against the vault's own `pending` / `escrow` tallies and THROWS on a
 * mismatch, so simply completing against the live vault proves the layout still
 * holds. This test exists to run that check on demand.
 */
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config } from '@/config/predict';
import { readLpQueues, type QueueCapableClient } from './lp-queue';

const RUN = process.env.RUN_LIVE === '1';

describe.skipIf(!RUN)('readLpQueues (live testnet)', () => {
  it('decodes both queues and reconciles with the vault tallies', async () => {
    const client = new SuiGrpcClient({
      network: 'testnet',
      baseUrl: predictV2Config.grpcUrl,
    });

    // Throws if the parsed entries disagree with the vault's pending/escrow.
    const q = await readLpQueues(client.core as unknown as QueueCapableClient);

    for (const [label, side] of [
      ['supply', q.supply],
      ['withdraw', q.withdraw],
    ] as const) {
      expect(BigInt(side.entries.length), `${label} count`).toBe(side.pending);
      expect(
        side.entries.reduce((s, e) => s + e.amount, 0n),
        `${label} escrow`,
      ).toBe(side.escrow);
      for (const e of side.entries) {
        expect(e.amount, 'a queued request escrows a positive amount').toBeGreaterThan(0n);
        expect(e.accountId).toMatch(/^0x[0-9a-f]{64}$/);
        expect(e.recipient).toMatch(/^0x[0-9a-f]{64}$/);
      }
      // FIFO: the keeper fills in ascending index, and cancel takes this index.
      const idx = side.entries.map((e) => e.index);
      expect([...idx].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(idx);
    }

    console.log(
      `supply: ${q.supply.entries.length} pending / ${q.supply.escrow} escrowed · ` +
        `withdraw: ${q.withdraw.entries.length} pending / ${q.withdraw.escrow} escrowed`,
    );
    for (const e of q.supply.entries) {
      console.log(`  supply #${e.index} account ${e.accountId.slice(0, 10)}… amount ${e.amount}`);
    }
  }, 30_000);
});
