import { describe, it, expect } from 'vitest';
import { parseStylePrefs, hasStylePrefs, preferenceLine } from './style-prefs';

describe('parseStylePrefs', () => {
  it('reads the auto-remember phrasing', () => {
    expect(parseStylePrefs(['leans UP and prefers safer bets'])).toEqual({ lean: 'up', risk: 'safe' });
    expect(parseStylePrefs(['leans DOWN and likes bolder, higher-payout bets'])).toEqual({ lean: 'down', risk: 'bold' });
    expect(parseStylePrefs(['likes range bets on BTC'])).toEqual({ likesRange: true });
  });

  it('reads loose free-text memories too', () => {
    expect(parseStylePrefs(['I am usually bullish on btc'])).toMatchObject({ lean: 'up' });
    expect(parseStylePrefs(['prefers a longshot for the big payout'])).toMatchObject({ risk: 'bold' });
    expect(parseStylePrefs(['likes to be conservative'])).toMatchObject({ risk: 'safe' });
  });

  it('lets the FIRST (most relevant) note win a conflict', () => {
    expect(parseStylePrefs(['leans UP and safer', 'leans DOWN and bolder'])).toEqual({ lean: 'up', risk: 'safe' });
  });

  it('returns empty for notes with no style signal', () => {
    expect(parseStylePrefs(['asked about the fear and greed index'])).toEqual({});
    expect(parseStylePrefs([])).toEqual({});
  });
});

describe('hasStylePrefs', () => {
  it('is true only when something is set', () => {
    expect(hasStylePrefs({})).toBe(false);
    expect(hasStylePrefs({ lean: 'up' })).toBe(true);
    expect(hasStylePrefs({ likesRange: true })).toBe(true);
  });
});

describe('preferenceLine', () => {
  it('builds a natural lead-in from lean + risk', () => {
    expect(preferenceLine({ lean: 'up', risk: 'safe' })).toBe(
      "Since you usually lean UP and keep it safer, here's one in that style.",
    );
    expect(preferenceLine({ lean: 'down' })).toBe("Since you usually lean DOWN, here's one in that style.");
    expect(preferenceLine({ risk: 'bold' })).toBe("Since you usually go for bigger payouts, here's one in that style.");
  });

  it('is null when there is nothing directional/risky to say', () => {
    expect(preferenceLine({})).toBeNull();
    expect(preferenceLine({ likesRange: true })).toBeNull();
  });
});
