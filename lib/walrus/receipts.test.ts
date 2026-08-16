import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import {
  stableStringify,
  canonicalBytes,
  verifyReceiptSignature,
  scoreCall,
  trackRecord,
  summarizeClaim,
  type CallClaim,
  type CallReceipt,
  type CallReceiptCore,
  type ReceiptIndexEntry,
} from './receipts';

const binaryClaim: CallClaim = {
  kind: 'binary',
  asset: 'BTC',
  direction: 'up',
  strike: 115_000,
  probability: 0.68,
  spotAtCall: 116_200,
  forward: 116_250,
  expiry: 2_000_000_000_000,
  marketId: '0xmarket-a',
};

const rangeClaim: CallClaim = {
  kind: 'range',
  asset: 'BTC',
  lower: 112_000,
  higher: 118_000,
  probability: 0.5,
  spotAtCall: 115_000,
  forward: 115_050,
  expiry: 2_000_000_000_000,
  marketId: '0xmarket-b',
};

/** Build + sign a receipt the same way mintCallReceipt does, minus the network store. */
async function signedReceipt(keypair: Ed25519Keypair, claim: CallClaim): Promise<CallReceipt> {
  const core: CallReceiptCore = {
    version: 1,
    author: 'kelly',
    source: 'rules',
    createdAt: 1_700_000_000_000,
    id: 'test-id',
    claim,
  };
  const signature = toBase64(await keypair.sign(canonicalBytes(core)));
  return {
    ...core,
    signature,
    publicKey: keypair.getPublicKey().toBase64(),
    signerAddress: keypair.toSuiAddress(),
  };
}

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
  it('sorts nested object keys too', () => {
    const s = stableStringify({ z: { d: 1, c: 2 }, a: [3, { y: 1, x: 2 }] });
    expect(s).toBe('{"a":[3,{"x":2,"y":1}],"z":{"c":2,"d":1}}');
  });
});

describe('receipt authorship signature', () => {
  it('verifies a genuine receipt', async () => {
    const kp = new Ed25519Keypair();
    const r = await signedReceipt(kp, binaryClaim);
    expect(await verifyReceiptSignature(r)).toBe(true);
  });

  it('fails when the claim is tampered after signing', async () => {
    const kp = new Ed25519Keypair();
    const r = await signedReceipt(kp, binaryClaim);
    const tampered: CallReceipt = { ...r, claim: { ...r.claim, strike: 100_000 } };
    expect(await verifyReceiptSignature(tampered)).toBe(false);
  });

  it('fails when the public key does not match the signer address', async () => {
    const kp = new Ed25519Keypair();
    const other = new Ed25519Keypair();
    const r = await signedReceipt(kp, binaryClaim);
    const swapped: CallReceipt = { ...r, publicKey: other.getPublicKey().toBase64() };
    expect(await verifyReceiptSignature(swapped)).toBe(false);
  });
});

describe('scoreCall', () => {
  it('scores an UP call won when settlement is above the strike', () => {
    expect(scoreCall(binaryClaim, 116_000)).toBe('won');
    expect(scoreCall(binaryClaim, 114_000)).toBe('lost');
  });
  it('scores a DOWN call by the inverse', () => {
    const down: CallClaim = { ...binaryClaim, direction: 'down' };
    expect(scoreCall(down, 114_000)).toBe('won');
    expect(scoreCall(down, 116_000)).toBe('lost');
  });
  it('scores a range call won only inside (lower, higher]', () => {
    expect(scoreCall(rangeClaim, 115_000)).toBe('won');
    expect(scoreCall(rangeClaim, 118_000)).toBe('won'); // inclusive upper
    expect(scoreCall(rangeClaim, 112_000)).toBe('lost'); // exclusive lower
    expect(scoreCall(rangeClaim, 120_000)).toBe('lost');
  });
  it('is pending without a settlement', () => {
    expect(scoreCall(binaryClaim, null)).toBe('pending');
    expect(scoreCall(binaryClaim, undefined)).toBe('pending');
    expect(scoreCall(binaryClaim, NaN)).toBe('pending');
  });
});

describe('trackRecord', () => {
  const rows: ReceiptIndexEntry[] = [
    { id: '1', blobId: 'b1', createdAt: 1, source: 'rules', claim: binaryClaim }, // up @115k
    { id: '2', blobId: 'b2', createdAt: 2, source: 'rules', claim: { ...binaryClaim, marketId: '0xm2' } },
    { id: '3', blobId: 'b3', createdAt: 3, source: 'ai', claim: { ...rangeClaim, marketId: '0xm3' } },
    { id: '4', blobId: 'b4', createdAt: 4, source: 'rules', claim: { ...binaryClaim, marketId: '0xpending' } },
  ];
  const settlements: Record<string, number | null> = {
    '0xmarket-a': 116_000, // up won
    '0xm2': 114_000, // up lost
    '0xm3': 115_000, // range won
    '0xpending': null, // not settled
  };

  it('aggregates won/lost/pending and a resolved-only win rate', () => {
    const tr = trackRecord(rows, (id) => settlements[id] ?? null);
    expect(tr.total).toBe(4);
    expect(tr.won).toBe(2);
    expect(tr.lost).toBe(1);
    expect(tr.pending).toBe(1);
    expect(tr.resolved).toBe(3);
    expect(tr.winRate).toBeCloseTo(2 / 3, 5);
  });

  it('reports a null win rate when nothing has resolved', () => {
    const tr = trackRecord(rows, () => null);
    expect(tr.resolved).toBe(0);
    expect(tr.pending).toBe(4);
    expect(tr.winRate).toBeNull();
  });
});

describe('summarizeClaim', () => {
  it('labels a binary call', () => {
    expect(summarizeClaim(binaryClaim)).toBe('BTC above $115,000 (68%)');
  });
  it('labels a range call', () => {
    expect(summarizeClaim(rangeClaim)).toBe('BTC stays $112,000–$118,000 (50%)');
  });
});
