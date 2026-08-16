/**
 * Live end-to-end proof for Verifiable Call Receipts. Network-gated — runs only with
 * RUN_LIVE=1 and a funded writer key:
 *
 *   RUN_LIVE=1 npx vitest run lib/walrus/receipts.live.test.ts
 *
 * Mints a real receipt (signs it, stores it on Walrus through the upload relay), then reads it
 * back from the public aggregator by blobId and verifies the authorship signature — proving the
 * whole "immutable + content-addressed + Kelly-signed" chain against live testnet, not fixtures.
 * Needs WALRUS_WRITER_KEY (funded) in .env, same as the Phase 0 blob round-trip.
 */
import { describe, it, expect } from 'vitest';
import { mintCallReceipt, readCallReceipt, scoreCall, type CallClaim } from './receipts';

const RUN = process.env.RUN_LIVE === '1';

describe.skipIf(!RUN)('call receipts (live testnet Walrus)', () => {
  it('mints, reads back, verifies, and scores a call', async () => {
    const claim: CallClaim = {
      kind: 'binary',
      asset: 'BTC',
      direction: 'up',
      strike: 100_000,
      probability: 0.61,
      spotAtCall: 101_500,
      forward: 101_600,
      expiry: Date.now() + 5 * 60_000,
      marketId: `0xlive-${Date.now()}`,
    };

    const { id, blobId } = await mintCallReceipt({ claim, source: 'rules' });
    expect(id).toBeTruthy();
    expect(blobId).toBeTruthy();

    // Read it back from the public aggregator and verify Kelly's signature.
    const { receipt, verified } = await readCallReceipt(blobId);
    expect(verified).toBe(true);
    expect(receipt.id).toBe(id);
    expect(receipt.claim.strike).toBe(100_000);
    expect(receipt.author).toBe('kelly');

    // And it scores correctly against a hypothetical settlement.
    expect(scoreCall(receipt.claim, 100_500)).toBe('won');
    expect(scoreCall(receipt.claim, 99_500)).toBe('lost');
  }, 120_000);
});
