import { describe, it, expect } from 'vitest';
import { sanitizeConversation, upsertEntry, type ConversationIndexEntry } from './chat-history';

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
