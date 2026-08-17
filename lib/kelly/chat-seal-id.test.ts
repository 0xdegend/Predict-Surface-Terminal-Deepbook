import { describe, it, expect } from 'vitest';
import { chatSealId, chatSealIdBytes, wrapSealEnvelope, readSealEnvelope } from './chat-seal-id';
import { normalizeSuiAddress, fromHex } from '@mysten/sui/utils';

const owner = '0x2';

describe('chatSealId', () => {
  it('starts with the owner 32-byte address, then the conversation id', () => {
    const id = chatSealId(owner, 'c-abc');
    expect(id.startsWith(normalizeSuiAddress(owner).slice(2))).toBe(true);
    expect(id.length).toBeGreaterThan(64); // 32-byte address (64 hex) + the convo id bytes
  });

  it('is deterministic and unique per conversation', () => {
    expect(chatSealId(owner, 'c1')).toBe(chatSealId(owner, 'c1'));
    expect(chatSealId(owner, 'c1')).not.toBe(chatSealId(owner, 'c2'));
  });

  it('the id bytes begin with the exact 32 address bytes (what seal_approve checks)', () => {
    const bytes = chatSealIdBytes(owner, 'c1');
    const addrBytes = fromHex(normalizeSuiAddress(owner).slice(2));
    expect(addrBytes.length).toBe(32);
    expect(Array.from(bytes.slice(0, 32))).toEqual(Array.from(addrBytes));
  });
});

describe('seal envelope', () => {
  it('round-trips a ciphertext', () => {
    const env = wrapSealEnvelope('abcd', 'Y2lwaGVy');
    expect(readSealEnvelope(env)).toEqual(env);
  });

  it('rejects a non-seal blob (legacy plaintext transcript)', () => {
    expect(readSealEnvelope({ id: 'x', messages: [] })).toBeNull();
    expect(readSealEnvelope(null)).toBeNull();
    expect(readSealEnvelope({ enc: 'seal', ct: 5 })).toBeNull();
  });
});
