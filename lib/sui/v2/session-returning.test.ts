/**
 * A redeploy must not turn a returning trader into a first-timer.
 *
 * Session keys are scoped to their deployment's package, so every per-deployment record
 * starts empty after a cutover. The confirm dialog decides whether to PRE-ARM instant
 * trading from exactly those records, and on 2026-09-17 that meant everyone who had been
 * trading with no wallet pop-up on 8-21 silently went back to one on every 9-12 trade.
 * Nothing was broken and nothing said anything; it just felt slower.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hadSessionOnEarlierRelease } from './session';
import { predictConfigFor, predictV2Config, KNOWN_V2_DEPLOYMENTS } from '@/config/predict';

const OWNER = '0xAbCdEf0000000000000000000000000000000000000000000000000000000001';
const key = (owner: string, pkg: string) => `skew.sessionAddrs.${owner.toLowerCase()}.${pkg}`;

/** A release that is NOT the active one, i.e. one a cutover left behind. */
const earlier = KNOWN_V2_DEPLOYMENTS.filter(
  (d) => predictConfigFor(d).packages.predict && predictConfigFor(d).packages.predict !== predictV2Config.packages.predict,
);

describe('hadSessionOnEarlierRelease', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is false for a wallet that never armed one anywhere', () => {
    expect(hadSessionOnEarlierRelease(OWNER)).toBe(false);
  });

  it('is false without an owner', () => {
    expect(hadSessionOnEarlierRelease(null)).toBe(false);
    expect(hadSessionOnEarlierRelease(undefined)).toBe(false);
  });

  it('finds a key left on ANY earlier release', () => {
    expect(earlier.length, 'the active deployment must not be the only one known').toBeGreaterThan(0);
    for (const d of earlier) {
      window.localStorage.setItem(key(OWNER, predictConfigFor(d).packages.predict), JSON.stringify(['0xsession']));
      expect(hadSessionOnEarlierRelease(OWNER), d).toBe(true);
      window.localStorage.removeItem(key(OWNER, predictConfigFor(d).packages.predict));
    }
  });

  it('IGNORES the active release, which the live session check already covers', () => {
    window.localStorage.setItem(key(OWNER, predictV2Config.packages.predict), JSON.stringify(['0xsession']));
    expect(hadSessionOnEarlierRelease(OWNER)).toBe(false);
  });

  it('is per wallet, so one trader’s history never arms another’s', () => {
    const other = '0x00000000000000000000000000000000000000000000000000000000000000ff';
    window.localStorage.setItem(key(other, predictConfigFor(earlier[0]!).packages.predict), JSON.stringify(['0xsession']));
    expect(hadSessionOnEarlierRelease(OWNER)).toBe(false);
  });

  it('survives an unreadable or empty entry rather than throwing', () => {
    window.localStorage.setItem(key(OWNER, predictConfigFor(earlier[0]!).packages.predict), 'not json');
    expect(hadSessionOnEarlierRelease(OWNER)).toBe(false);
    window.localStorage.setItem(key(OWNER, predictConfigFor(earlier[0]!).packages.predict), JSON.stringify([]));
    expect(hadSessionOnEarlierRelease(OWNER)).toBe(false);
  });
});
