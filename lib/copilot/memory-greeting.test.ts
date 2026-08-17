import { describe, it, expect } from 'vitest';
import { welcomeBackLines, welcomeBackFromHint, rememberedName, personalizeMemory, recallReplyLines } from './memory-greeting';

describe('rememberedName', () => {
  it('extracts a name from a saved "your name is X" note', () => {
    expect(rememberedName(['your name is Degendev'])).toBe('Degendev');
    expect(rememberedName(['leans UP', 'my name is Bob', 'likes range bets'])).toBe('Bob');
  });

  it('returns null when no name note is present', () => {
    expect(rememberedName(['leans UP and prefers safer bets'])).toBeNull();
    expect(rememberedName([])).toBeNull();
  });
});

describe('welcomeBackLines — name-forward continuity', () => {
  it('returns no lines for a brand-new trader (no notes)', () => {
    expect(welcomeBackLines([])).toEqual([]);
    expect(welcomeBackLines(['   ', '', '\n'])).toEqual([]);
  });

  it('greets by name when a name is remembered, and shows no memory list', () => {
    const lines = welcomeBackLines(['your name is Degendev', 'leans UP']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Hey Degendev');
    expect(lines.join(' ')).not.toContain('•'); // no dumped memory list
  });

  it('nudges once for a name when the trader has notes but no name', () => {
    const lines = welcomeBackLines(['leans UP and prefers safer bets']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Good to see you back');
    expect(lines[0].toLowerCase()).toContain('tell me your name');
  });
});

describe('welcomeBackFromHint — same greeting from a cached hint (no recall)', () => {
  it('greets by name when the hint carries one, matching welcomeBackLines', () => {
    const lines = welcomeBackFromHint({ name: 'Degendev', hasNotes: true });
    expect(lines).toEqual(welcomeBackLines(['your name is Degendev']));
    expect(lines[0]).toContain('Hey Degendev');
  });

  it('nudges for a name when there are notes but no name', () => {
    const lines = welcomeBackFromHint({ name: null, hasNotes: true });
    expect(lines).toHaveLength(1);
    expect(lines[0].toLowerCase()).toContain('tell me your name');
  });

  it('says nothing for a brand-new trader (no name, no notes)', () => {
    expect(welcomeBackFromHint({ name: null, hasNotes: false })).toEqual([]);
  });
});

describe('recallReplyLines — answers the question that was asked', () => {
  it('answers a name question directly from memory', () => {
    expect(recallReplyLines('name', ['your name is Degendev', 'leans UP'])).toEqual(['Your name is Degendev.']);
  });

  it('nudges when a name is asked for but not saved', () => {
    const lines = recallReplyLines('name', ['leans UP and prefers safer bets']);
    expect(lines).toHaveLength(1);
    expect(lines[0].toLowerCase()).toContain('my name is');
  });

  it('answers a style question in second person, excluding the bare name note', () => {
    const lines = recallReplyLines('style', ['your name is Degendev', 'leans UP and prefers safer bets']);
    expect(lines).toEqual(['You lean UP and prefer safer bets.']);
  });

  it('lists multiple style notes as personalized bullets', () => {
    const lines = recallReplyLines('style', ['leans UP', 'likes range bets around FOMC']);
    expect(lines[0]).toContain('how you like to trade');
    expect(lines.slice(1)).toEqual(['• you lean UP', '• you like range bets around FOMC']);
  });

  it('nudges when style is asked for but nothing is saved (name-only memory)', () => {
    const lines = recallReplyLines('style', ['your name is Degendev']);
    expect(lines).toHaveLength(1);
    expect(lines[0].toLowerCase()).toContain('trading style');
  });

  it('general recall reads back what is remembered', () => {
    expect(recallReplyLines('general', [])).toHaveLength(1);
    expect(recallReplyLines('general', ['leans UP'])).toEqual(['I remember that you lean UP.']);
    expect(recallReplyLines('general', ['leans UP', 'my name is Bob'])[0]).toContain('what I remember about you');
  });
});

describe('personalizeMemory — second-person rewrite', () => {
  it('strips a third-person subject and gives a subjectless note a "you" subject', () => {
    expect(personalizeMemory('This trader likes range bets around FOMC')).toBe('you like range bets around FOMC');
    expect(personalizeMemory('likes range bets on BTC')).toBe('you like range bets on BTC');
  });

  it('de-conjugates every known preference verb, including after "and"', () => {
    expect(personalizeMemory('leans UP and prefers safer bets')).toBe('you lean UP and prefer safer bets');
    expect(personalizeMemory('leans DOWN')).toBe('you lean DOWN');
  });

  it('turns a first-person note into second person', () => {
    expect(personalizeMemory('I prefer safer up bets')).toBe('you prefer safer up bets');
    expect(personalizeMemory('I avoid leverage')).toBe('you avoid leverage');
    expect(personalizeMemory('I like BTC 1h markets')).toBe('you like BTC 1h markets');
  });

  it('swaps my/me/mine and leaves an already-second-person fact intact', () => {
    expect(personalizeMemory('my target is 5% a week')).toBe('your target is 5% a week');
    expect(personalizeMemory('you prefer range bets')).toBe('you prefer range bets');
  });

  it('preserves casing of non-pronoun tokens (BTC, FOMC, UP)', () => {
    expect(personalizeMemory('likes FOMC range plays on BTC')).toBe('you like FOMC range plays on BTC');
  });
});
