import { describe, it, expect } from 'vitest';
import { plainPunctuation } from './setup-ai';

describe('plainPunctuation', () => {
  it('replaces the exact em dash the live model produced', () => {
    expect(plainPunctuation('Got it—running for half an hour with your fifty bucks.')).toBe(
      'Got it, running for half an hour with your fifty bucks.',
    );
  });

  it('handles en dashes too', () => {
    expect(plainPunctuation('Cautious – $25 – one hour.')).toBe('Cautious, $25, one hour.');
  });

  it('does not double up punctuation', () => {
    expect(plainPunctuation('Sure, — $50 it is.')).toBe('Sure, $50 it is.');
    expect(plainPunctuation('Done —.')).toBe('Done.');
  });

  it('leaves clean copy untouched', () => {
    const clean = "You're putting in 50 dollars for this run.";
    expect(plainPunctuation(clean)).toBe(clean);
  });

  it('never leaves a dash behind', () => {
    for (const s of ['a—b', 'a – b', '—lead', 'trail—']) {
      expect(plainPunctuation(s)).not.toMatch(/[—–]/);
    }
  });
});
