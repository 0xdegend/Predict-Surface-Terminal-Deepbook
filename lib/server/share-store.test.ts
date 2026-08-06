import { describe, it, expect } from 'vitest';
import {
  createShortLink,
  resolveShortLink,
  recordShareEvent,
  getRefStats,
  cleanShareRef,
} from './share-store';

// No KV env in tests → the in-process fallback path is exercised.

describe('short links', () => {
  it('round-trips a token through a short id', async () => {
    const id = await createShortLink('tok-abc');
    expect(id).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(await resolveShortLink(id)).toBe('tok-abc');
  });

  it('returns distinct ids for distinct links', async () => {
    const a = await createShortLink('one');
    const b = await createShortLink('two');
    expect(a).not.toBe(b);
    expect(await resolveShortLink(a)).toBe('one');
    expect(await resolveShortLink(b)).toBe('two');
  });

  it('returns null for an unknown or malformed id', async () => {
    expect(await resolveShortLink('nope0000')).toBeNull();
    expect(await resolveShortLink('bad id!')).toBeNull();
    expect(await resolveShortLink('')).toBeNull();
  });
});

describe('referral attribution', () => {
  it('tallies opens and converts per ref', async () => {
    const ref = 'alice_' + Math.random().toString(36).slice(2, 8);
    await recordShareEvent('open', ref);
    await recordShareEvent('open', ref);
    await recordShareEvent('convert', ref);
    expect(await getRefStats(ref)).toEqual({ open: 2, convert: 1 });
  });

  it('ignores a missing ref for per-ref stats but still records globally', async () => {
    await recordShareEvent('open'); // no throw, no per-ref key
    expect(await getRefStats('')).toEqual({ open: 0, convert: 0 });
  });
});

describe('cleanShareRef', () => {
  it('strips separators and caps length', () => {
    expect(cleanShareRef('  al ex!! ')).toBe('alex');
    expect(cleanShareRef('a'.repeat(100))?.length).toBe(40);
    expect(cleanShareRef(undefined)).toBeUndefined();
    expect(cleanShareRef('!!!')).toBeUndefined();
  });

  it('keeps safe id characters', () => {
    expect(cleanShareRef('alex_1.2-3')).toBe('alex_1.2-3');
  });
});
