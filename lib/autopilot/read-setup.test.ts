import { describe, it, expect, vi } from 'vitest';
import { readSetup } from './read-setup';
import { missingFrom } from './setup-parser';

/** A fetch stand-in that returns whatever the route would have returned. */
function fakeFetch(reply: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => reply })) as unknown as typeof fetch;
}

const NONE = { known: {}, asking: [] as never[] };

describe('readSetup', () => {
  it('falls back to the rule parser when the model is unavailable', async () => {
    const r = await readSetup({ message: 'cautious, $25 for an hour', ...NONE, fetchImpl: fakeFetch({ available: false }) });
    expect(r.source).toBe('rules');
    expect(r.intent).toMatchObject({ preset: 'cautious', budgetUsd: 25, durationMins: 60 });
  });

  it('reads a phrasing the rules alone would miss', async () => {
    const message = 'keep me out of trouble, fifty bucks, till lunch';
    const r = await readSetup({
      message,
      ...NONE,
      fetchImpl: fakeFetch({
        available: true,
        intent: { style: 'cautious', budgetUsd: 50, durationMins: 90, note: 'Got it, cautious with $50.' },
        note: 'Got it, cautious with $50.',
      }),
    });
    expect(r.source).toBe('ai');
    expect(r.intent).toMatchObject({ preset: 'cautious', presetNamed: true, budgetUsd: 50, durationMins: 90 });
    expect(missingFrom(r.intent)).toEqual([]);
  });

  it('keeps the rule reading for fields the model stayed silent on', async () => {
    // The model only caught the style; "$25" and "an hour" still come from the rules.
    const r = await readSetup({
      message: 'play it safe, $25 for an hour',
      ...NONE,
      fetchImpl: fakeFetch({ available: true, intent: { style: 'cautious' } }),
    });
    expect(r.intent).toMatchObject({ preset: 'cautious', budgetUsd: 25, durationMins: 60 });
  });

  it('never lets the model invent an amount past the sane bounds', async () => {
    const r = await readSetup({
      message: 'go bold',
      ...NONE,
      fetchImpl: fakeFetch({ available: true, intent: { style: 'bold', budgetUsd: 9_000_000 } }),
    });
    expect(r.intent.budgetUsd).toBeUndefined();
    expect(missingFrom(r.intent)).toContain('budget');
  });

  it('survives a non-ok response, a throw, and junk JSON', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    for (const f of [fakeFetch({ available: true }, false), throwing, fakeFetch('not json at all')]) {
      const r = await readSetup({ message: 'bold $100 for 2 hours', ...NONE, fetchImpl: f });
      expect(r.intent).toMatchObject({ preset: 'bold', budgetUsd: 100, durationMins: 120 });
    }
  });

  it('reads a bare number as the answer to the question just asked', async () => {
    // The rules read a lone "50" as a budget already; the model is told which gap is
    // open so it agrees rather than guessing a different field.
    const r = await readSetup({
      message: '50',
      known: { style: 'cautious' },
      asking: ['budget'],
      fetchImpl: fakeFetch({ available: true, intent: { budgetUsd: 50 } }),
    });
    expect(r.intent.budgetUsd).toBe(50);
  });

  it('sends the known values and the open gap to the server', async () => {
    const spy = fakeFetch({ available: false });
    await readSetup({ message: 'make it double', known: { budgetUsd: 25 }, asking: ['duration'], fetchImpl: spy });
    const body = JSON.parse((spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toMatchObject({ message: 'make it double', known: { budgetUsd: 25 }, asking: ['duration'] });
  });
  /* Cases observed from the LIVE model during build. It returned an EMPTY intent for
     both, and the rule parser covers both, which is the whole reason the two readers
     are unioned rather than one replacing the other. If the model improves these stop
     being fallbacks and simply agree. */
  it('falls back to the rules when the model returns nothing for slang it was told to catch', async () => {
    const r = await readSetup({
      message: 'send it, let it rip',
      ...NONE,
      fetchImpl: fakeFetch({ available: true, intent: {} }),
    });
    expect(r.intent.preset).toBe('bold');
    expect(r.intent.presetNamed).toBe(true);
  });

  it('falls back to the rules when the model returns nothing for a bare answer', async () => {
    const r = await readSetup({
      message: '50',
      known: { style: 'cautious' },
      asking: ['budget'],
      fetchImpl: fakeFetch({ available: true, intent: {} }),
    });
    expect(r.intent.budgetUsd).toBe(50);
  });
});
