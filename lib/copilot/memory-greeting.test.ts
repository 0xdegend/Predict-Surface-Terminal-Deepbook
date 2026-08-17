import { describe, it, expect } from 'vitest';
import { welcomeBackLines, MAX_GREETING_MEMORIES, personalizeMemory } from './memory-greeting';

describe('welcomeBackLines — passive continuity', () => {
  it('returns no lines when there is nothing saved', () => {
    expect(welcomeBackLines([])).toEqual([]);
  });

  it('drops blank / whitespace-only memories (and returns nothing if all are blank)', () => {
    expect(welcomeBackLines(['   ', '', '\n'])).toEqual([]);
  });

  it('wraps a single memory with a header + prompt, phrased personally', () => {
    const lines = welcomeBackLines(['prefers safer UP bets near the money']);
    expect(lines).toEqual([
      'Good to see you back. Here’s what I remember about you:',
      '• you prefer safer UP bets near the money',
      'Want to pick up from there, or try something new?',
    ]);
  });

  it('trims each memory and renders it as a personal bullet', () => {
    const lines = welcomeBackLines(['  likes range bets around FOMC  ']);
    expect(lines[1]).toBe('• you like range bets around FOMC');
  });

  it('caps the bullets at MAX_GREETING_MEMORIES so the greeting stays light', () => {
    const many = ['a', 'b', 'c', 'd', 'e'];
    const lines = welcomeBackLines(many);
    const bullets = lines.filter((l) => l.startsWith('• '));
    expect(bullets).toHaveLength(MAX_GREETING_MEMORIES);
    expect(bullets).toEqual(['• a', '• b', '• c']);
    // header + capped bullets + prompt
    expect(lines).toHaveLength(MAX_GREETING_MEMORIES + 2);
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
