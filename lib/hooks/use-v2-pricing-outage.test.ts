/**
 * The banner must be steady, not chatty.
 *
 * A 9-12 market lives one minute, so the selected market rolls constantly. A signal derived
 * from the selected market alone blinks out every time a fresh market's query starts
 * pending, and a banner that flickers once a minute is one people learn to ignore. These
 * pin the two ends: nothing fires on a first paint where everything is merely pending, and
 * nothing keeps firing once anything at all can be priced again.
 */
import { describe, it, expect } from 'vitest';

/** The exact predicate the hook applies to its observed query results. */
const outage = (results: { isError: boolean; data?: unknown }[], ids: number) =>
  ids > 0 && results.some((r) => r.isError) && results.every((r) => !r.data);

const pending = { isError: false, data: undefined };
const failed = { isError: true, data: undefined };
const priced = { isError: false, data: { forward: 1 } };

describe('pricing outage predicate', () => {
  it('stays quiet on a first paint, where everything is merely pending', () => {
    expect(outage([pending, pending, pending], 3)).toBe(false);
  });

  it('fires when every live market has failed', () => {
    expect(outage([failed, failed, failed], 3)).toBe(true);
  });

  it('stays up through a market roll, when a fresh market is still pending', () => {
    // The 1m market that just appeared has no verdict yet; the others already failed.
    expect(outage([failed, failed, pending], 3)).toBe(true);
  });

  it('clears the moment ANY market quotes again', () => {
    expect(outage([failed, failed, priced], 3)).toBe(false);
  });

  it('does not fire for one unlucky market while the rest quote', () => {
    expect(outage([failed, priced, priced], 3)).toBe(false);
  });

  it('is false with no markets at all, which is the paused case, not an outage', () => {
    expect(outage([], 0)).toBe(false);
  });
});
