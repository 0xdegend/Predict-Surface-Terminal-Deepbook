import { describe, it, expect } from 'vitest';
import { isMeaningfulMemory } from './memory-quality';

describe('isMeaningfulMemory', () => {
  it('rejects the filler fragments a loose "remember that …" parse leaves behind', () => {
    for (const junk of ['from now', 'for later', 'from now on', 'going forward', 'that', 'ok', '', '   ']) {
      expect(isMeaningfulMemory(junk), junk).toBe(false);
    }
  });

  it('keeps any note with real content, including short ones', () => {
    for (const real of [
      'your name is Degendev',
      'leans UP and prefers safer bets',
      'I prefer safer up bets',
      'likes range bets around FOMC',
      'my target is 5% a week',
      'loves BTC',
      'from now on I trade mornings', // the same "from now" tail, but now with content
    ]) {
      expect(isMeaningfulMemory(real), real).toBe(true);
    }
  });
});
