import { describe, it, expect } from 'vitest';
import { optionsShareText, money, type OptionsShareCard } from './options-share';

const NO_EMDASH = /—/;

describe('money', () => {
  it('formats whole dollars with thousands separators', () => {
    expect(money(64646)).toBe('$64,646');
    expect(money(64645.7)).toBe('$64,646');
    expect(money(1000000)).toBe('$1,000,000');
  });
});

describe('optionsShareText', () => {
  it('market_read: quotes the headline, tags @skew_sui, no em-dash', () => {
    const card: OptionsShareCard = {
      kind: 'market_read',
      asset: 'BTC',
      headline: 'Right now the overall market is pulling both ways.',
      lines: [{ tone: 'up', text: 'BTC is up.' }],
      sentiment: { value: 27, label: 'Fear' },
    };
    const t = optionsShareText(card);
    expect(t).toContain('BTC');
    expect(t).toContain('pulling both ways');
    expect(t).toContain('@skew_sui');
    expect(t).not.toMatch(NO_EMDASH);
  });

  it('expected_range: states the band, the horizon, and the 2-in-3 odds', () => {
    const card: OptionsShareCard = {
      kind: 'expected_range',
      asset: 'BTC',
      forward: 64_665,
      spot: 64_665,
      sigmaPct: 1.8,
      lowPrice: 63_200,
      highPrice: 66_100,
      horizon: '2h',
    };
    const t = optionsShareText(card);
    expect(t).toContain('$63,200');
    expect(t).toContain('$66,100');
    expect(t).toContain('2h');
    expect(t).toMatch(/2 in 3/);
    expect(t).toContain('@skew_sui');
    expect(t).not.toMatch(NO_EMDASH);
  });

  it('bold_odds: leads with the probability, the strike, and the payout', () => {
    const card: OptionsShareCard = {
      kind: 'bold_odds',
      asset: 'BTC',
      strike: 64_646,
      chancePct: 72,
      payoutX: 1.38,
      horizon: '2h',
      isUp: true,
    };
    const t = optionsShareText(card);
    expect(t).toContain('72%');
    expect(t).toContain('holding above');
    expect(t).toContain('$64,646');
    expect(t).toContain('1.38x');
    expect(t).toContain('@skew_sui');
    expect(t).not.toMatch(NO_EMDASH);
  });

  it('bold_odds: flips the phrasing for a below-strike call', () => {
    const card: OptionsShareCard = {
      kind: 'bold_odds',
      asset: 'BTC',
      strike: 64_646,
      chancePct: 40,
      payoutX: 2.5,
      horizon: '13m',
      isUp: false,
    };
    expect(optionsShareText(card)).toContain('staying below');
  });
});
