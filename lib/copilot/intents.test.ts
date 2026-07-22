import { describe, it, expect } from 'vitest';
import { parseIntent } from './intents';

describe('parseIntent', () => {
  it('empty / greeting → help', () => {
    expect(parseIntent('').kind).toBe('help');
    expect(parseIntent('   ').kind).toBe('help');
    expect(parseIntent('hey').kind).toBe('help');
  });

  it('analysis asks → analyze', () => {
    for (const m of [
      'analyse the btc movements for me',
      'analyze BTC',
      "what's happening with bitcoin",
      'how is BTC doing',
      'give me the market outlook',
      'read the sentiment for me',
    ]) {
      expect(parseIntent(m).kind, m).toBe('analyze');
    }
  });

  it('a single clear direction → directional_bet with that side', () => {
    const up = parseIntent('I think BTC goes up in the next hour');
    expect(up).toMatchObject({ kind: 'directional_bet', dir: 'up', horizon: 'hour' });

    const down = parseIntent('give me a bet that BTC falls');
    expect(down).toMatchObject({ kind: 'directional_bet', dir: 'down' });
  });

  it('reads conviction', () => {
    expect(parseIntent('safe up bet')).toMatchObject({ dir: 'up', conviction: 'safe' });
    expect(parseIntent('a longshot up bet')).toMatchObject({ dir: 'up', conviction: 'longshot' });
    expect(parseIntent('a risky down play')).toMatchObject({ dir: 'down', conviction: 'longshot' });
    expect(parseIntent('bet on up')).toMatchObject({ dir: 'up', conviction: 'even' });
  });

  it('reads horizon', () => {
    expect(parseIntent('safe up bet for the next hour')).toMatchObject({ horizon: 'hour' });
    expect(parseIntent('quick up bet')).toMatchObject({ horizon: 'soonest' });
    expect(parseIntent('an up bet in 1h')).toMatchObject({ horizon: 'hour' });
  });

  it('both directions ("up or down?") is a question → analyze, not a bet', () => {
    expect(parseIntent('should I go up or down?').kind).toBe('analyze');
  });

  it('"which/what is the next market" → next_market', () => {
    for (const m of [
      'What is the next market',
      'next market',
      'which market can I bet on?',
      'soonest market',
      "when's the next round",
      'what market is coming up',
    ]) {
      expect(parseIntent(m).kind, m).toBe('next_market');
    }
  });

  it('"market" without a next/soonest qualifier stays analyze', () => {
    expect(parseIntent('how is the market doing').kind).toBe('analyze');
  });

  it('a direction still wins over next_market ("down bet on the next market")', () => {
    expect(parseIntent('down bet on the next market')).toMatchObject({ kind: 'directional_bet', dir: 'down' });
  });

  it('"set up a trade" / guided phrasings → start_trade', () => {
    for (const m of [
      'I want to set up a trade',
      'set up a trade',
      'build a trade',
      'walk me through a trade',
      'guide me',
      'step by step',
    ]) {
      expect(parseIntent(m).kind, m).toBe('start_trade');
    }
  });

  it('"set up" alone does not become an UP bet', () => {
    // NON_DIRECTIONAL strips "set up"; a fully-specified "set up a safe up bet"
    // still reads as a directional up bet, not the wizard.
    expect(parseIntent('set up a safe up bet')).toMatchObject({ kind: 'directional_bet', dir: 'up' });
    expect(parseIntent("what's coming up").kind).not.toBe('directional_bet');
  });

  it('a bet verb with no clear side → help (never guesses direction)', () => {
    expect(parseIntent('place a bet for me').kind).toBe('help');
    expect(parseIntent('I want to trade').kind).toBe('help');
  });

  it('does not fire a bet on direction-word substrings (whole-word matching)', () => {
    // "understand" contains "under" (a DOWN word) but must NOT read as a bet.
    expect(parseIntent('help me understand bitcoin').kind).not.toBe('directional_bet');
  });
});
