import { describe, it, expect } from 'vitest';
import { defaultExpiryId, expiryLabel, expiryLabelShort, READABLE_HORIZON_MS } from './expiry-choice';

const NOW = 1_700_000_000_000;
const at = (secs: number) => ({ marketId: `m${secs}`, expiryMs: NOW + secs * 1000 });

describe('defaultExpiryId', () => {
  it('skips the settlement race and opens on the first readable expiry', () => {
    const picked = defaultExpiryId([at(10), at(70), at(300), at(7200)], NOW);
    expect(picked).toBe('m300');
  });

  it('opens on the soonest readable one, not the longest', () => {
    expect(defaultExpiryId([at(10), at(600), at(7200)], NOW)).toBe('m600');
  });

  it('falls back to the longest available when everything is about to settle', () => {
    // A ladder of 30-second markets is still better than an empty page.
    expect(defaultExpiryId([at(10), at(25), at(40)], NOW)).toBe('m40');
  });

  it('returns null with nothing to pick', () => {
    expect(defaultExpiryId([], NOW)).toBeNull();
  });

  it('takes the threshold as a parameter', () => {
    expect(defaultExpiryId([at(10), at(70), at(300)], NOW, 60_000)).toBe('m70');
    expect(READABLE_HORIZON_MS).toBe(180_000);
  });
});

describe('expiryLabel', () => {
  it('never labels a live market "0m"', () => {
    // The bug this replaces: Math.round(45s / 60s) = 0.
    expect(expiryLabel(NOW + 45_000, NOW)).toBe('45 sec');
    expect(expiryLabel(NOW + 1_000, NOW)).toBe('1 sec');
  });

  it('reads in the unit a person would say', () => {
    expect(expiryLabel(NOW + 11 * 60_000, NOW)).toBe('11 min');
    expect(expiryLabel(NOW + 2 * 3_600_000, NOW)).toBe('2 hr');
    expect(expiryLabel(NOW + 26 * 3_600_000, NOW)).toBe('1 day');
    expect(expiryLabel(NOW + 72 * 3_600_000, NOW)).toBe('3 days');
  });

  it('never claims more time than is left, so labels agree with the landing rule', () => {
    // Rounding called 2m40s "3 min", which put a pill above the readable threshold while
    // the rule (correctly) skipped it. Flooring keeps the two telling the same story.
    expect(expiryLabel(NOW + 160_000, NOW)).toBe('2 min');
    expect(expiryLabel(NOW + 180_000, NOW)).toBe('3 min');
    expect(expiryLabel(NOW + 209_000, NOW)).toBe('3 min');
    expect(expiryLabel(NOW + 119 * 60_000, NOW)).toBe('1 hr');
  });

  it('says "now" once it is past', () => {
    expect(expiryLabel(NOW, NOW)).toBe('now');
    expect(expiryLabel(NOW - 5_000, NOW)).toBe('now');
  });

  it('shortens for tight chips without changing the rounding', () => {
    expect(expiryLabelShort(NOW + 45_000, NOW)).toBe('45s');
    expect(expiryLabelShort(NOW + 11 * 60_000, NOW)).toBe('11m');
    expect(expiryLabelShort(NOW + 2 * 3_600_000, NOW)).toBe('2h');
    expect(expiryLabelShort(NOW + 72 * 3_600_000, NOW)).toBe('3d');
  });
});
