import { describe, it, expect } from 'vitest';
import { sanitizeConversation, sanitizeEncryptedInput, upsertEntry, type ConversationIndexEntry } from './chat-history';
import { wrapSealEnvelope } from '@/lib/kelly/chat-seal-id';

const NOW = 1_800_000_000_000;

describe('sanitizeConversation — untrusted input hardening', () => {
  it('accepts a real conversation and keeps text + a bet summary', () => {
    const convo = sanitizeConversation(
      'conv-abcdef',
      [
        { role: 'assistant', text: ['Hi, I am Kelly.'] },
        { role: 'user', text: ['safe up bet'] },
        { role: 'assistant', text: ['Here is an UP bet.'], bet: { isUp: true, strike: 115000, prob: 0.66, amount: 20 } },
      ],
      NOW,
    );
    expect(convo).not.toBeNull();
    expect(convo!.id).toBe('conv-abcdef');
    expect(convo!.messages).toHaveLength(3);
    expect(convo!.messages[2].bet).toEqual({ isUp: true, strike: 115000, prob: 0.66, amount: 20 });
    expect(convo!.createdAt).toBe(NOW);
  });

  it('rejects a bad id', () => {
    expect(sanitizeConversation('', [{ role: 'user', text: ['hi'] }], NOW)).toBeNull();
    expect(sanitizeConversation('short', [{ role: 'user', text: ['hi'] }], NOW)).toBeNull(); // < 6 chars
    expect(sanitizeConversation('has spaces!!', [{ role: 'user', text: ['hi'] }], NOW)).toBeNull();
  });

  it('rejects a conversation with no user message (nothing worth saving)', () => {
    expect(sanitizeConversation('conv-abcdef', [{ role: 'assistant', text: ['Hi.'] }], NOW)).toBeNull();
    expect(sanitizeConversation('conv-abcdef', [], NOW)).toBeNull();
  });

  it('drops junk messages and coerces roles', () => {
    const convo = sanitizeConversation(
      'conv-abcdef',
      [null, 42, { role: 'system', text: ['nope'] }, { role: 'user', text: ['real', 123, null] }],
      NOW,
    );
    expect(convo).not.toBeNull();
    expect(convo!.messages).toHaveLength(1);
    expect(convo!.messages[0]).toEqual({ role: 'user', text: ['real'] }); // non-string lines dropped
  });

  it('ignores a malformed bet/range but keeps the text', () => {
    const convo = sanitizeConversation(
      'conv-abcdef',
      [{ role: 'user', text: ['x'] }, { role: 'assistant', text: ['ok'], bet: { isUp: true } }],
      NOW,
    );
    expect(convo!.messages[1].bet).toBeUndefined();
    expect(convo!.messages[1].text).toEqual(['ok']);
  });
});

describe('sanitizeEncryptedInput — encrypted save hardening', () => {
  const env = wrapSealEnvelope('dede0558abcd', 'Y2lwaGVydGV4dA=='); // { v:1, enc:'seal', id, ct }

  it('accepts a valid id + Seal envelope + count', () => {
    const out = sanitizeEncryptedInput('conv-abcdef', env, 7);
    expect(out).not.toBeNull();
    expect(out!.id).toBe('conv-abcdef');
    expect(out!.enc).toEqual(env);
    expect(out!.count).toBe(7);
  });

  it('rejects a bad id', () => {
    expect(sanitizeEncryptedInput('short', env, 3)).toBeNull();
    expect(sanitizeEncryptedInput('has spaces!!', env, 3)).toBeNull();
  });

  it('rejects a non-envelope enc (e.g. leaked plaintext messages)', () => {
    expect(sanitizeEncryptedInput('conv-abcdef', { messages: [{ role: 'user', text: ['hi'] }] }, 1)).toBeNull();
    expect(sanitizeEncryptedInput('conv-abcdef', null, 1)).toBeNull();
    expect(sanitizeEncryptedInput('conv-abcdef', { enc: 'seal', ct: 5, id: 'x' }, 1)).toBeNull();
  });

  it('rejects an oversized ciphertext', () => {
    const huge = wrapSealEnvelope('id', 'A'.repeat(2_000_001));
    expect(sanitizeEncryptedInput('conv-abcdef', huge, 1)).toBeNull();
  });

  it('clamps a junk count into range', () => {
    expect(sanitizeEncryptedInput('conv-abcdef', env, 0)!.count).toBe(1);
    expect(sanitizeEncryptedInput('conv-abcdef', env, -4)!.count).toBe(1);
    expect(sanitizeEncryptedInput('conv-abcdef', env, 99_999)!.count).toBe(500);
    expect(sanitizeEncryptedInput('conv-abcdef', env, NaN)!.count).toBe(1);
  });
});

describe('upsertEntry — index bookkeeping', () => {
  const mk = (id: string, updatedAt: number): ConversationIndexEntry => ({
    id,
    blobId: `blob-${id}`,
    createdAt: 1,
    updatedAt,
    count: 2,
    preview: id,
  });

  it('adds a new entry newest-first', () => {
    const out = upsertEntry([mk('a', 10)], mk('b', 20));
    expect(out.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('replaces an existing entry by id and re-sorts by updatedAt (no duplicate)', () => {
    const start = [mk('a', 10), mk('b', 20)];
    const out = upsertEntry(start, { ...mk('a', 30), blobId: 'blob-a-new' });
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out.filter((e) => e.id === 'a')).toHaveLength(1);
    expect(out[0].blobId).toBe('blob-a-new');
  });
});
