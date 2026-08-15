import { describe, it, expect } from 'vitest';
import { welcomeBackLines, MAX_GREETING_MEMORIES } from './memory-greeting';

describe('welcomeBackLines — passive continuity', () => {
  it('returns no lines when there is nothing saved', () => {
    expect(welcomeBackLines([])).toEqual([]);
  });

  it('drops blank / whitespace-only memories (and returns nothing if all are blank)', () => {
    expect(welcomeBackLines(['   ', '', '\n'])).toEqual([]);
  });

  it('wraps a single memory with a header + prompt', () => {
    const lines = welcomeBackLines(['prefers safer UP bets near the money']);
    expect(lines).toEqual([
      'Good to see you back. Here’s what I remember about you:',
      '• prefers safer UP bets near the money',
      'Want to pick up from there, or try something new?',
    ]);
  });

  it('trims each memory and renders it as a bullet', () => {
    const lines = welcomeBackLines(['  likes range bets around FOMC  ']);
    expect(lines[1]).toBe('• likes range bets around FOMC');
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
