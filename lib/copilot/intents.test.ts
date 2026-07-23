import { describe, it, expect } from 'vitest';
import { parseIntent, isPlaceConfirmation } from './intents';

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

  it('"should I go up or down (or range)?" → a recommendation (a steer, not a bet)', () => {
    for (const m of [
      'should I go up or down?',
      'Should take an up trade now or down trade?',
      'up or down?',
      'which way should I trade, up down or range?',
      'what do you think I should do?',
      "what's your call",
    ]) {
      expect(parseIntent(m).kind, m).toBe('recommend');
    }
  });

  it('a balance question → balance', () => {
    for (const m of [
      'what is my wallet balance',
      "what's my balance",
      'how much dusdc do I have',
      'how much do I have',
      'my wallet',
      'check my funds',
    ]) {
      expect(parseIntent(m).kind, m).toBe('balance');
    }
  });

  it('a portfolio / performance question → portfolio (not the funds-only balance)', () => {
    for (const m of [
      'How is my portfolio now?',
      'how are my bets doing',
      'my positions',
      'how am I doing',
      'am I up or down',
      "what's my pnl",
      'how is my portfolio',
      'how are my trades performing',
    ]) {
      expect(parseIntent(m).kind, m).toBe('portfolio');
    }
    // A plain funds question is still the focused balance answer.
    expect(parseIntent("what's my balance").kind).toBe('balance');
  });

  it('"analyse the current / this strike" → analyze_strike (not the whole-market read)', () => {
    for (const m of [
      'Analyse the current live strike for me',
      'analyze this strike',
      'read this strike',
      "how's this strike looking",
      'is this strike a good bet',
      'break down the current strike',
    ]) {
      expect(parseIntent(m).kind, m).toBe('analyze_strike');
    }
    // "analyze BTC" / "analyse the market" (no strike) stay the general read.
    expect(parseIntent('analyze BTC').kind).toBe('analyze');
    expect(parseIntent('analyse the market').kind).toBe('analyze');
  });

  it('a clear single direction still wins over a recommendation ask', () => {
    // "should I take a safe up bet?" has one side → it's a bet, not a steer.
    expect(parseIntent('should I take a safe up bet?')).toMatchObject({ kind: 'directional_bet', dir: 'up' });
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

  it('"what is the market live now" (and open/available) → next_market, not analyze', () => {
    for (const m of [
      'What is the market live now',
      'is the market live right now',
      'any market open right now',
      'is a market available to trade',
    ]) {
      expect(parseIntent(m).kind, m).toBe('next_market');
    }
  });

  it('"market" without a next/soonest/live qualifier stays analyze', () => {
    expect(parseIntent('how is the market doing').kind).toBe('analyze');
    expect(parseIntent('give me the market outlook').kind).toBe('analyze');
  });

  it('a direct metric question → metric (not the full analyze read)', () => {
    expect(parseIntent('What is the BTC fear and greed right now?')).toMatchObject({ kind: 'metric', metric: 'fear_greed' });
    expect(parseIntent('is it greed or fear today')).toMatchObject({ kind: 'metric', metric: 'fear_greed' });
    expect(parseIntent("what's the funding rate")).toMatchObject({ kind: 'metric', metric: 'funding' });
    expect(parseIntent('how are liquidations looking')).toMatchObject({ kind: 'metric', metric: 'liquidations' });
    expect(parseIntent('where is max pain')).toMatchObject({ kind: 'metric', metric: 'max_pain' });
  });

  it('bare "sentiment" stays an analyze read, not the fear/greed metric', () => {
    expect(parseIntent('read the sentiment for me').kind).toBe('analyze');
  });

  it('quick-fact metrics (price / 24h / open interest)', () => {
    expect(parseIntent("what's the btc price")).toMatchObject({ kind: 'metric', metric: 'price' });
    expect(parseIntent('how much is btc up today')).toMatchObject({ kind: 'metric', metric: 'change_24h' });
    expect(parseIntent('24h change')).toMatchObject({ kind: 'metric', metric: 'change_24h' });
    expect(parseIntent("what's the open interest")).toMatchObject({ kind: 'metric', metric: 'open_interest' });
    // "up bet today" must NOT be read as a 24h-change question.
    expect(parseIntent('give me an up bet today').kind).toBe('directional_bet');
  });

  it('"what are the odds at $X / of a Y% move" → odds', () => {
    expect(parseIntent('what are the odds btc is above 67k in 5 min')).toMatchObject({ kind: 'odds', level: { kind: 'strike', price: 67000 }, dir: 'up' });
    expect(parseIntent('how likely is a 1% move up')).toMatchObject({ kind: 'odds', level: { kind: 'move', pct: 1 }, dir: 'up' });
    expect(parseIntent('odds of a 2 percent drop')).toMatchObject({ kind: 'odds', level: { kind: 'move', pct: 2 } });
    expect(parseIntent('what are the chances at 66000')).toMatchObject({ kind: 'odds', level: { kind: 'strike', price: 66000 } });
  });

  it('surface-native analysis questions route to their own intents', () => {
    expect(parseIntent('how big a move is priced in for the next 5 min').kind).toBe('volatility');
    expect(parseIntent('is the market bracing for a crash or a pump').kind).toBe('skew');
    expect(parseIntent('1 minute or 5 minute for up')).toMatchObject({ kind: 'term_structure', dir: 'up' });
    expect(parseIntent('which expiry has better odds').kind).toBe('term_structure');
    expect(parseIntent('any mispricings on the surface').kind).toBe('no_arb');
    expect(parseIntent('is the surface arbitrage free').kind).toBe('no_arb');
  });

  it('"which strike has the most volume" → busiest_strike, scoped by a now-cue', () => {
    // A "now"-style cue scopes to the current live market; otherwise all expiries.
    expect(parseIntent('which strike has the most volume right now from the surface?')).toMatchObject({ kind: 'busiest_strike', scope: 'now' });
    expect(parseIntent('busiest strike right now')).toMatchObject({ kind: 'busiest_strike', scope: 'now' });
    expect(parseIntent('which strike has the most volume')).toMatchObject({ kind: 'busiest_strike', scope: 'all' });
    expect(parseIntent('where is the most action on the surface')).toMatchObject({ kind: 'busiest_strike', scope: 'all' });
    expect(parseIntent('most traded strike')).toMatchObject({ kind: 'busiest_strike', scope: 'all' });
    // "biggest move" is volatility, not volume-by-strike.
    expect(parseIntent('how big a move is priced in').kind).toBe('volatility');
  });

  it('reality-check questions route to reality_check (with the level when given)', () => {
    expect(parseIntent('how often does a 1% move up actually happen')).toMatchObject({ kind: 'reality_check', level: { kind: 'move', pct: 1 }, dir: 'up' });
    expect(parseIntent('has btc really moved above 66500 lately')).toMatchObject({ kind: 'reality_check', level: { kind: 'strike', price: 66500 } });
    expect(parseIntent('historically how often does it drop').kind).toBe('reality_check');
  });

  it('an explicit target on a directional bet ("70% chance", "double my money")', () => {
    expect(parseIntent('give me a 70% chance up bet')).toMatchObject({ kind: 'directional_bet', dir: 'up', target: { kind: 'prob', value: 0.7 } });
    expect(parseIntent('double my money on an up bet')).toMatchObject({ kind: 'directional_bet', dir: 'up', target: { kind: 'payout', mult: 2 } });
    // "70% chance" is a probability, NOT a 70% price move → not odds.
    expect(parseIntent('give me a 70% chance up bet').kind).toBe('directional_bet');
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

  it('a parameter-packed message → start_trade, however it is phrased', () => {
    for (const m of [
      'Set up my trade for me, strike 66,000, leverage 2x, bet amount 6 dusdc',
      'strike 66000, 2x leverage, 6 dusdc',
      'trade 66000 strike with leverage 2',
      'buy strike 65k, 3x, bet 10',
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

describe('isPlaceConfirmation', () => {
  it('recognizes a short "place the bet now" confirmation', () => {
    for (const m of ['trade it', 'Trade it.', 'place it', 'place this bet', 'open it', 'do it', 'confirm', 'yes', 'sure', "let's go", 'let’s go', 'send it', 'trade this']) {
      expect(isPlaceConfirmation(m), m).toBe(true);
    }
  });

  it('does NOT treat a new trade spec, a bare verb, or unrelated text as a confirmation', () => {
    for (const m of [
      'trade 66000 strike', // a new spec (start_trade), not a confirm
      'set up a trade',
      'trade', // too bare
      'I want to place a bet at 65000 with 2x leverage',
      'what are the odds',
      'analyze BTC',
      'no',
    ]) {
      expect(isPlaceConfirmation(m), m).toBe(false);
    }
  });
});
