import { describe, it, expect } from 'vitest';
import { parseIntent, isPlaceConfirmation, placeConfirmation, isFlowInterruption, type CopilotIntent } from './intents';

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

  it('calendar / macro-event asks → events', () => {
    for (const m of [
      "what's happening today",
      'what is happening today?', // spelled-out "what is" (the reported miss)
      'what is going on today',
      'anything big today?',
      'is there FOMC today',
      'any events this week',
      'is there a rate decision coming up',
      'what CPI is out today',
      "what's on the calendar",
      'any market-moving events',
      'what are the events happening today',
      "what's going on this week",
      // past-tense recap phrasings (events already released earlier today)
      'What are the notable events that happened today?',
      'what events happened today',
      'What happened today?', // bare recap, no "events" noun
      'anything happen today?',
      'did anything happen today',
    ]) {
      expect(parseIntent(m).kind, m).toBe('events');
    }
  });

  it('does NOT route the plain reads / personal / causal asks to events', () => {
    // No day anchor → the plain market read.
    expect(parseIntent("what's happening with bitcoin").kind).toBe('analyze');
    expect(parseIntent('what is happening').kind).toBe('analyze'); // "what is", but no day anchor
    expect(parseIntent('how is BTC doing').kind).toBe('analyze');
    // Personal book, even with "today".
    expect(parseIntent("how's my pnl today").kind).toBe('portfolio');
    // A causal "why … today" stays the driver read.
    expect(parseIntent('why is btc moving today').kind).toBe('why_moving');
  });

  it('events is a flow interruption (answerable mid-wizard)', () => {
    expect(isFlowInterruption({ kind: 'events', range: 'today' })).toBe(true);
  });

  it('picks the horizon (today / week / month) an events question asks about', () => {
    const range = (m: string) => {
      const i = parseIntent(m);
      return i.kind === 'events' ? i.range : `not-events:${i.kind}`;
    };
    expect(range('any events this week'), 'this week').toBe('week');
    expect(range('what is on the calendar this month'), 'this month').toBe('month');
    expect(range("what's coming up on the calendar"), 'coming up').toBe('week');
    expect(range('any upcoming economic events'), 'upcoming').toBe('week');
    expect(range('events over the coming weeks'), 'coming weeks').toBe('month');
    // No window named → defaults to today.
    expect(range('is there FOMC'), 'no window').toBe('today');
    expect(range('what happened today'), 'today').toBe('today');
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

  it('"what range should I trade in / recommend a range" → range_bet (with width)', () => {
    const parse = (m: string) => parseIntent(m);
    for (const m of [
      'what range should I trade in?',
      'recommend a range',
      'suggest a range to bet',
      'what range should I bet on',
      'pick a good range for me',
      'give me a range to trade',
      'build me a range',
    ]) {
      expect(parse(m).kind, m).toBe('range_bet');
    }
    // Width cues map to conviction (wider = safer, tighter = longshot).
    const width = (m: string) => {
      const i = parse(m);
      return i.kind === 'range_bet' ? i.conviction : `not-range:${i.kind}`;
    };
    expect(width('recommend a safe range'), 'safe').toBe('safe');
    expect(width('a wide range to trade'), 'wide').toBe('safe');
    expect(width('give me a tight range'), 'tight').toBe('longshot');
    expect(width('a narrow range to bet'), 'narrow').toBe('longshot');
    expect(width('what range should I trade'), 'default').toBe('even');
  });

  it('definitional range asks and the up/down/range steer do NOT route to range_bet', () => {
    // "what's a range bet / how do range bets work" stays the glossary.
    expect(parseIntent("what's a range bet?").kind).toBe('explain');
    expect(parseIntent('how do range bets work').kind).toBe('explain');
    // "up or down or range?" is a directional steer, not a band request.
    expect(parseIntent('should I go up, down, or range?').kind).toBe('recommend');
    expect(parseIntent('which way should I trade, up down or range?').kind).toBe('recommend');
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
      // "how is my trade going" — the single-open-trade check the user asked for
      'how is my trade going',
      "how's my trade",
      'check my trade',
      // the "open"/"live" adjective must not derail it (was hitting analyze/help)
      'how is my open trade',
      'show my open trade',
      'check my open position',
      "how's my live bet doing",
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

  it('"analyse 64,500 strike" carries the named price (reads THAT strike, not the selected one)', () => {
    expect(parseIntent('Analyse 64,500 strike for me')).toMatchObject({ kind: 'analyze_strike', price: 64500 });
    expect(parseIntent('analyze the 65k strike')).toMatchObject({ kind: 'analyze_strike', price: 65000 });
    expect(parseIntent('read the 66,200 down strike')).toMatchObject({ kind: 'analyze_strike', price: 66200, dir: 'down' });
    // "analyse this strike" (no number) still routes there, with no price.
    const bare = parseIntent('analyze this strike');
    expect(bare.kind).toBe('analyze_strike');
    expect((bare as { price?: number }).price).toBeUndefined();
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

  it('"how volatile is the surface right now" → volatility (not no_arb via "right now")', () => {
    expect(parseIntent('How volatile is the surface right now?').kind).toBe('volatility');
    expect(parseIntent('is BTC volatile right now').kind).toBe('volatility');
    // The "is the surface right?" (correct) sense still routes to the no-arb check.
    expect(parseIntent('is the surface right').kind).toBe('no_arb');
    expect(parseIntent('is the surface healthy').kind).toBe('no_arb');
  });

  it('"why does the surface look like this?" → surface_shape (a live shape read)', () => {
    for (const m of [
      'why is the surface looking like this',
      'why does the surface look like that',
      'why is the surface shaped this way',
      'why is the surface so steep',
      'why is the surface tilted',
      'why does the surface look so lopsided',
      "what's up with the surface shape",
      'what does the surface look like right now',
      'explain why the surface looks like this',
      'why is the surface so red today',
    ]) {
      expect(parseIntent(m).kind, m).toBe('surface_shape');
    }
    // Definitional "what is the surface" (no appearance cue) stays the explainer,
    // and "how do I read the surface" stays the how-to explainer.
    expect(parseIntent('what is the surface')).toMatchObject({ kind: 'explain', topic: 'surface' });
    expect(parseIntent('how do I read the surface')).toMatchObject({ kind: 'explain', topic: 'surface' });
    // A bare "why is it so steep" (no surface noun) is NOT a surface_shape read.
    expect(parseIntent('why is it so steep').kind).not.toBe('surface_shape');
  });

  it('overall volume/activity → surface_volume; naming a strike stays busiest_strike', () => {
    expect(parseIntent('How is the volume like on the surface right now?')).toMatchObject({ kind: 'surface_volume', scope: 'now' });
    expect(parseIntent('how busy is the surface').kind).toBe('surface_volume');
    expect(parseIntent('how much is being bet right now')).toMatchObject({ kind: 'surface_volume', scope: 'now' });
    expect(parseIntent('is it active on the surface').kind).toBe('surface_volume');
    expect(parseIntent("what's the volume across all markets")).toMatchObject({ kind: 'surface_volume', scope: 'all' });
    // "which strike / where's the volume" still names the level → busiest_strike.
    expect(parseIntent('which strike has the most volume').kind).toBe('busiest_strike');
    expect(parseIntent("where's the volume on the surface").kind).toBe('busiest_strike');
    // Not about the trader's own book.
    expect(parseIntent('how much is my bet worth').kind).not.toBe('surface_volume');
  });

  it('"what can I bet on" → markets_overview; "biggest payout / longshot" → biggest_payout', () => {
    expect(parseIntent('what can I bet on right now').kind).toBe('markets_overview');
    expect(parseIntent('how many markets are there').kind).toBe('markets_overview');
    expect(parseIntent('how far out can I bet').kind).toBe('markets_overview');
    expect(parseIntent('what timeframes can I trade').kind).toBe('markets_overview');
    expect(parseIntent("where's the biggest payout on the surface").kind).toBe('biggest_payout');
    expect(parseIntent('longest shot on the surface').kind).toBe('biggest_payout');
    expect(parseIntent('find me a moonshot').kind).toBe('biggest_payout');
    expect(parseIntent('biggest win I can get').kind).toBe('biggest_payout');
    // Guards: a directional longshot bet and "best bet" don't get hijacked.
    expect(parseIntent('give me a longshot up bet').kind).toBe('directional_bet');
    expect(parseIntent("what's the best bet right now").kind).toBe('best_value');
  });

  it('"find/show me the $X strike" → find_strike (locate it), with the price', () => {
    expect(parseIntent('Find me the 64,730 strike on the surface?')).toMatchObject({ kind: 'find_strike', price: 64730 });
    expect(parseIntent('show me 65,200 on the surface')).toMatchObject({ kind: 'find_strike', price: 65200 });
    expect(parseIntent('where is 66,000 on the surface')).toMatchObject({ kind: 'find_strike', price: 66000 });
    expect(parseIntent('highlight the 64,900 strike')).toMatchObject({ kind: 'find_strike', price: 64900 });
    // A find-cue beats the trade-param branch ("strike at 64,730" alone → wizard).
    expect(parseIntent('find the strike at 64,730')).toMatchObject({ kind: 'find_strike', price: 64730 });
    // A direction carries through when named.
    expect(parseIntent('find the 64,730 down strike')).toMatchObject({ kind: 'find_strike', price: 64730, dir: 'down' });
    // No price → not a find; "most volume on the surface" stays busiest_strike.
    expect(parseIntent('find me a safe up bet').kind).not.toBe('find_strike');
    expect(parseIntent('where is the most volume on the surface').kind).toBe('busiest_strike');
  });

  it('a chance question carries a time horizon (soon vs today vs an hour)', () => {
    expect(parseIntent('what is the chance BTC is above 65k soon')).toMatchObject({ kind: 'odds', horizon: 'soonest' });
    expect(parseIntent('what is the chance BTC is above 65k today')).toMatchObject({ kind: 'odds', horizon: 'today' });
    expect(parseIntent('odds BTC is above 65,000 in a few hours')).toMatchObject({ kind: 'odds', horizon: 'today' });
    expect(parseIntent('chance BTC is above 65k in the next hour')).toMatchObject({ kind: 'odds', horizon: 'hour' });
    // no time word → the soonest market
    expect(parseIntent('what are the odds BTC is above 65k')).toMatchObject({ kind: 'odds', horizon: 'soonest' });
  });

  it('"pick / search / choose / select the $X strike" also → find_strike', () => {
    expect(parseIntent('Pick 65,965 strike for me on the surface')).toMatchObject({ kind: 'find_strike', price: 65965 });
    expect(parseIntent('Search for 65,965 strike on the surface')).toMatchObject({ kind: 'find_strike', price: 65965 });
    expect(parseIntent('choose the 64,500 strike')).toMatchObject({ kind: 'find_strike', price: 64500 });
    expect(parseIntent('select 66k on the surface')).toMatchObject({ kind: 'find_strike', price: 66000 });
    // A soft verb with NO strike is not a find (falls through to its real intent).
    expect(parseIntent('pick a safe up bet').kind).not.toBe('find_strike');
    // A sizing token means it's a trade SETUP → wizard, not a locate.
    expect(parseIntent('pick strike 66000 at 2x').kind).toBe('start_trade');
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

  it('"set up a trade" / "open a trade" / guided phrasings → start_trade', () => {
    for (const m of [
      'I want to set up a trade',
      'set up a trade',
      'open a trade for me', // the reported lapse
      'open a bet',
      'open a position for me',
      'start a trade',
      'start a bet please',
      'new trade',
      'enter a trade',
      'make a bet',
      'place a bet for me',
      'build a trade',
      'walk me through a trade',
      'guide me',
      'step by step',
    ]) {
      expect(parseIntent(m).kind, m).toBe('start_trade');
    }
  });

  it('a DIRECTION between the verb and object still routes to a one-shot suggestion, not the wizard', () => {
    // "open a safe down trade" must stay a DOWN suggestion (the direction breaks the
    // "open a trade" phrase match), same as "set up a quick safe down trade".
    expect(parseIntent('open a safe down trade for me')).toMatchObject({ kind: 'directional_bet', dir: 'down' });
    expect(parseIntent('start a safe up bet')).toMatchObject({ kind: 'directional_bet', dir: 'up' });
    // But "open the trade" / "open it" are place-confirmations (handled before parse).
    expect(isPlaceConfirmation('open the trade')).toBe(true);
    expect(isPlaceConfirmation('open a trade for me')).toBe(false); // a fresh setup, not a confirm
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

  it('a bare bet verb (no side, no "a trade/bet" object) → help (never guesses direction)', () => {
    // "place a bet for me" now starts the wizard (it asks the side) — see the
    // start_trade phrasings test. A bare verb with no object still can't be guessed.
    expect(parseIntent('I want to trade').kind).toBe('help');
    expect(parseIntent('buy').kind).toBe('help');
  });

  it('does not fire a bet on direction-word substrings (whole-word matching)', () => {
    // "understand" contains "under" (a DOWN word) but must NOT read as a bet.
    expect(parseIntent('help me understand bitcoin').kind).not.toBe('directional_bet');
    // "how long" no longer trips the UP word "long".
    expect(parseIntent('how long until it settles').kind).not.toBe('directional_bet');
  });

  it('"how does X work / what if I lose" → explain (glossary), not the market read', () => {
    expect(parseIntent('what does leverage do?')).toMatchObject({ kind: 'explain', topic: 'leverage' });
    expect(parseIntent('what is a range bet')).toMatchObject({ kind: 'explain', topic: 'range' });
    expect(parseIntent('what happens if I lose')).toMatchObject({ kind: 'explain', topic: 'loss' });
    expect(parseIntent('how do you make money')).toMatchObject({ kind: 'explain', topic: 'fees' });
    expect(parseIntent('what is dusdc')).toMatchObject({ kind: 'explain', topic: 'funds' });
    expect(parseIntent('how do payouts work')).toMatchObject({ kind: 'explain', topic: 'payout' });
    expect(parseIntent('how does this work')).toMatchObject({ kind: 'explain', topic: 'predict' });
    // Data questions stay data questions.
    expect(parseIntent('how much dusdc do I have').kind).toBe('balance');
    expect(parseIntent('how are liquidations looking').kind).toBe('metric');
  });

  it('newcomer options + product questions → explain glossary (BTC options / how Skew works)', () => {
    expect(parseIntent('what is a call option?')).toMatchObject({ kind: 'explain', topic: 'call_put' });
    expect(parseIntent('what is a put?')).toMatchObject({ kind: 'explain', topic: 'call_put' });
    expect(parseIntent('what is an option')).toMatchObject({ kind: 'explain', topic: 'option' });
    expect(parseIntent('what is a strike price')).toMatchObject({ kind: 'explain', topic: 'strike' });
    expect(parseIntent('what is expiry')).toMatchObject({ kind: 'explain', topic: 'expiry' });
    expect(parseIntent('what is implied volatility')).toMatchObject({ kind: 'explain', topic: 'implied_vol' });
    expect(parseIntent('what does volatility mean')).toMatchObject({ kind: 'explain', topic: 'implied_vol' });
    expect(parseIntent('what is the premium')).toMatchObject({ kind: 'explain', topic: 'premium' });
    expect(parseIntent('what does in the money mean')).toMatchObject({ kind: 'explain', topic: 'moneyness' });
    expect(parseIntent('what is the surface')).toMatchObject({ kind: 'explain', topic: 'surface' });
    expect(parseIntent('what is the vault')).toMatchObject({ kind: 'explain', topic: 'vault' });
    expect(parseIntent('how does skew work')).toMatchObject({ kind: 'explain', topic: 'predict' });
    expect(parseIntent('what is skew')).toMatchObject({ kind: 'explain', topic: 'predict' });
  });

  it('live-data asks are NOT stolen by the newcomer glossary', () => {
    expect(parseIntent("what's the volatility right now")).toMatchObject({ kind: 'volatility' });
    expect(parseIntent("what's the skew")).toMatchObject({ kind: 'skew' });
    expect(parseIntent('which expiry is better')).toMatchObject({ kind: 'term_structure' });
  });

  it('product FAQ about Skew → explain (points / safety / rewards)', () => {
    // Mechanism asks (no first-person cue) stay the generic points explainer.
    for (const m of ['how are the leaderboard points accumulated', 'how do points work', 'what are points', 'how does the leaderboard work', 'explain the point system']) {
      expect(parseIntent(m), m).toMatchObject({ kind: 'explain', topic: 'points' });
    }
    for (const m of ['is my money safe', 'is it safe', 'is skew a scam', 'do you hold my funds', 'is this non-custodial', 'can you access my wallet']) {
      expect(parseIntent(m), m).toMatchObject({ kind: 'explain', topic: 'safety' });
    }
    for (const m of ['what are quests', 'how do competitions work', 'how does the rewards program work', 'what is the degen arena']) {
      expect(parseIntent(m), m).toMatchObject({ kind: 'explain', topic: 'rewards' });
    }
  });

  it('PERSONAL leaderboard questions → leaderboard_standing (not the mechanism explainer)', () => {
    // Status — "where do I sit?"
    for (const m of [
      'how am I performing on the leaderboard',
      'how am I doing on the leaderboard',
      "what's my rank",
      'where do I stand on the leaderboard',
      'how many points do I have',
      'am I winning on the leaderboard',
      "what's my leaderboard position",
    ]) {
      expect(parseIntent(m), m).toMatchObject({ kind: 'leaderboard_standing', focus: 'status' });
    }
    // Improve — "how do I get better?"
    for (const m of [
      'what do I need to do better to perform better on the leaderboard',
      'how do I climb the ranks',
      'how can I improve my rank',
      'what do I need to do to rank higher',
      'how do I earn more points',
      'help me climb the leaderboard',
    ]) {
      expect(parseIntent(m), m).toMatchObject({ kind: 'leaderboard_standing', focus: 'improve' });
    }
  });

  it('the FAQ never steals a balance / conviction / glossary question', () => {
    expect(parseIntent('how much dusdc do I have').kind).toBe('balance'); // "funds"-ish, still balance
    expect(parseIntent('safe up bet')).toMatchObject({ kind: 'directional_bet', conviction: 'safe' }); // "safe" is conviction
    expect(parseIntent("what's the point of leverage")).toMatchObject({ kind: 'explain', topic: 'leverage' }); // "point of" ≠ points
  });

  it('"open another one" / "set up another trade" → start_trade (a fresh setup)', () => {
    for (const m of ['open another one', 'set up another trade', 'another bet', 'start another', 'one more trade', 'give me a new one']) {
      expect(parseIntent(m).kind, m).toBe('start_trade');
    }
  });

  it('"what\'s the best value / underpriced?" → best_value', () => {
    for (const m of ["what's the best value right now?", 'where is the value', 'which strike is underpriced', 'best bet right now', 'good value bet']) {
      expect(parseIntent(m).kind, m).toBe('best_value');
    }
    // "which market has better odds" stays term_structure (not value).
    expect(parseIntent('which expiry has better odds').kind).toBe('term_structure');
  });

  it('"make it $10 / use 3x / flip to down" → adjust_ticket (edit, not a new trade)', () => {
    expect(parseIntent('make it $10')).toMatchObject({ kind: 'adjust_ticket', stake: 10 });
    expect(parseIntent('use 3x')).toMatchObject({ kind: 'adjust_ticket', leverage: 3 });
    expect(parseIntent('make it 3x')).toMatchObject({ kind: 'adjust_ticket', leverage: 3 });
    expect(parseIntent('change the strike to 65,500')).toMatchObject({ kind: 'adjust_ticket', strike: 65500 });
    expect(parseIntent('flip to down')).toMatchObject({ kind: 'adjust_ticket', dir: 'down' });
    expect(parseIntent('other side')).toMatchObject({ kind: 'adjust_ticket', flip: true });
    expect(parseIntent('make it $20 at 2x')).toMatchObject({ kind: 'adjust_ticket', stake: 20, leverage: 2 });
    // A fresh param-packed spec still builds a new trade (no modification cue).
    expect(parseIntent('strike 66000, 2x, 6 dusdc').kind).toBe('start_trade');
    expect(parseIntent('set up a trade, strike 66000, 2x').kind).toBe('start_trade');
  });

  it('flips direction on synonym/edit wording → adjust_ticket (keeps stake+leverage, not a new bet)', () => {
    // Plain-word sides ("below"/"above"), not just literal "up"/"down".
    expect(parseIntent('change it to btc below')).toMatchObject({ kind: 'adjust_ticket', dir: 'down' });
    expect(parseIntent('change it to below')).toMatchObject({ kind: 'adjust_ticket', dir: 'down' });
    expect(parseIntent('make it above')).toMatchObject({ kind: 'adjust_ticket', dir: 'up' });
    expect(parseIntent('switch to below')).toMatchObject({ kind: 'adjust_ticket', dir: 'down' });
    // Edit verbs.
    expect(parseIntent('edit it to down')).toMatchObject({ kind: 'adjust_ticket', dir: 'down' });
    expect(parseIntent('reverse it')).toMatchObject({ kind: 'adjust_ticket', flip: true });
    // A fresh directional bet (no edit cue) still builds a new one, not an edit.
    expect(parseIntent('safe up bet').kind).toBe('directional_bet');
    expect(parseIntent('go up').kind).toBe('directional_bet');
    // "move" stays the price-movement noun (reality-check / volatility), never an edit.
    expect(parseIntent('how often does a 1% move up actually happen').kind).toBe('reality_check');
    expect(parseIntent('how big a move is priced in').kind).toBe('volatility');
  });

  it('"close my up bet / redeem winnings / cash out the 65k" → close_position', () => {
    expect(parseIntent('close my up bet')).toMatchObject({ kind: 'close_position', dir: 'up' });
    expect(parseIntent('redeem my winnings')).toMatchObject({ kind: 'close_position', winnings: true });
    expect(parseIntent('cash out').kind).toBe('close_position');
    expect(parseIntent('close the 65k one')).toMatchObject({ kind: 'close_position', strike: 65000 });
    expect(parseIntent('close all')).toMatchObject({ kind: 'close_position', all: true });
    // "close" as an adjective is NOT a close request.
    expect(parseIntent('how close is BTC to 65k').kind).not.toBe('close_position');
  });

  it('"did I win my last trade / win rate / loss rate" → track_record', () => {
    expect(parseIntent('did I win my last trade?')).toMatchObject({ kind: 'track_record', focus: 'last', ask: 'win' });
    expect(parseIntent('did I lose my last trade?')).toMatchObject({ kind: 'track_record', focus: 'last', ask: 'lose' });
    expect(parseIntent('how did my last bet go')).toMatchObject({ kind: 'track_record', focus: 'last' });
    expect(parseIntent('how is my win rate right now')).toMatchObject({ kind: 'track_record', focus: 'win_rate' });
    expect(parseIntent("what's my win rate")).toMatchObject({ kind: 'track_record', focus: 'win_rate' });
    expect(parseIntent('how often do I win')).toMatchObject({ kind: 'track_record', focus: 'win_rate' });
    expect(parseIntent('what is my loss rate like')).toMatchObject({ kind: 'track_record', focus: 'loss_rate' });
    // "close my last bet" is an imperative to close — stays close_position, not a read.
    expect(parseIntent('close my last bet').kind).toBe('close_position');
    // A general "how am I doing" is still the portfolio roll-up, not track_record.
    expect(parseIntent('how is my portfolio').kind).toBe('portfolio');
    // "how often does a 1% move happen" is still the reality check, not a win-rate ask.
    expect(parseIntent('how often does a 1% move up happen').kind).toBe('reality_check');
  });

  it('"clear that position" → close_position (the LOST-bet verb)', () => {
    expect(parseIntent('clear that position').kind).toBe('close_position');
    expect(parseIntent('clear my down bet')).toMatchObject({ kind: 'close_position', dir: 'down' });
    expect(parseIntent('clear it').kind).toBe('close_position');
    expect(parseIntent('clear the 64,850 one')).toMatchObject({ kind: 'close_position', strike: 64850 });
    expect(parseIntent('clear all')).toMatchObject({ kind: 'close_position', all: true });
    // "clear" as an adjective / non-action is NOT a close request.
    expect(parseIntent('is that clear').kind).not.toBe('close_position');
    expect(parseIntent('that makes it clear').kind).not.toBe('close_position');
  });
});

describe('isPlaceConfirmation', () => {
  it('recognizes a short "place the bet now" confirmation', () => {
    for (const m of ['trade it', 'Trade it.', 'place it', 'place this bet', 'open it', 'open the trade', 'open the trade.', 'do it', 'confirm', 'yes', 'sure', "let's go", 'let’s go', 'send it', 'trade this']) {
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
      'should I trade it', // a question, not a confirm
      'do you think I should place it now', // a question
    ]) {
      expect(isPlaceConfirmation(m), m).toBe(false);
    }
  });
});

describe('placeConfirmation (confirm + inline stake/leverage override)', () => {
  it('a bare confirm returns an empty override object', () => {
    for (const m of ['trade it', 'place it', 'do it', 'yes', 'send it']) {
      expect(placeConfirmation(m), m).toEqual({});
    }
  });

  it('"trade it with 1 dusdc" carries the stake so the pending bet is placed at that size', () => {
    expect(placeConfirmation('trade it with 1 dusdc')).toEqual({ stake: 1 });
    expect(placeConfirmation('trade it with 1 DUSDC')).toEqual({ stake: 1 });
    expect(placeConfirmation('do it, 2 dusdc')).toEqual({ stake: 2 });
    expect(placeConfirmation('place it with $5')).toEqual({ stake: 5 });
    expect(placeConfirmation('trade it for 3 dusdc')).toEqual({ stake: 3 });
  });

  it('carries leverage, and both together', () => {
    expect(placeConfirmation('trade it at 2x')).toEqual({ leverage: 2 });
    expect(placeConfirmation('place it with 5 dusdc at 2x')).toEqual({ stake: 5, leverage: 2 });
    // A bare "2x" is leverage, never a $2 stake.
    expect(placeConfirmation('trade it 2x')).toEqual({ leverage: 2 });
  });

  it('a verb led straight into a size ("trade with 1 dusdc", no "it") is a sized confirm', () => {
    // The reported bug: "trade with 1 dusdc" must place the pending bet, not fall
    // through to a fresh wizard / navigate. A confirm verb + a pure size, no strike,
    // no side.
    expect(placeConfirmation('trade with 1 dusdc')).toEqual({ stake: 1 });
    expect(placeConfirmation('place 5 dusdc')).toEqual({ stake: 5 });
    expect(placeConfirmation('bet $10 at 2x')).toEqual({ stake: 10, leverage: 2 });
    expect(placeConfirmation('trade 2x')).toEqual({ leverage: 2 });
  });

  it('a size that also names a strike or a side is a fresh spec, not a confirm', () => {
    // A strike → start_trade owns it (a brand-new order, not a tweak to the pending bet).
    expect(placeConfirmation('trade 66000 with 5 dusdc')).toBeNull();
    // A direction → route to the directional suggestion, not a blind place.
    expect(placeConfirmation('trade up with 1 dusdc')).toBeNull();
    expect(placeConfirmation('buy down 2 dusdc')).toBeNull();
  });

  it('handles "trade it with 1 dusdc and 2x leverage" (the reported phrase) either word order', () => {
    expect(placeConfirmation('trade it with 1 dusdc and 2x leverage')).toEqual({ stake: 1, leverage: 2 });
    expect(placeConfirmation('trade it with 1 dusdc and 2 leverage')).toEqual({ stake: 1, leverage: 2 });
    expect(placeConfirmation('place it with 1 dusdc at 3x leverage')).toEqual({ stake: 1, leverage: 3 });
    expect(placeConfirmation('do it, leverage 2, 5 dusdc')).toEqual({ stake: 5, leverage: 2 });
  });

  it('returns null for non-confirmations (a new spec, a question, unrelated)', () => {
    for (const m of [
      'strike 66000, 2x, 6 dusdc', // a fresh spec → start_trade, not a confirm
      'I want to place a bet at 65000 with 2x leverage',
      'should I trade it with 1 dusdc',
      'what are the odds',
      'analyze BTC',
    ]) {
      expect(placeConfirmation(m), m).toBeNull();
    }
  });
});

describe('isFlowInterruption', () => {
  const asIntent = (kind: CopilotIntent['kind']) => ({ kind }) as unknown as CopilotIntent;

  it('pure informational reads interrupt the wizard (answer it, keep the trade paused)', () => {
    const reads = [
      'analyze', 'why_moving', 'positioning', 'flow', 'options_market',
      'volatility', 'skew', 'metric', 'reality_check', 'explain', 'no_arb',
      'term_structure', 'markets_overview', 'balance', 'portfolio', 'track_record',
    ] as const;
    for (const kind of reads) expect(isFlowInterruption(asIntent(kind)), kind).toBe(true);
  });

  it('flow answers, bet/highlight producers, and money + control intents do NOT interrupt', () => {
    const keepInFlow = [
      'help', 'start_trade', 'directional_bet', 'recommend', 'best_value',
      'biggest_payout', 'find_strike', 'odds', 'analyze_strike', 'next_market',
      'adjust_ticket', 'close_position', 'create_account', 'get_tokens',
      'onboarding', 'busiest_strike', 'surface_volume',
    ] as const;
    for (const kind of keepInFlow) expect(isFlowInterruption(asIntent(kind)), kind).toBe(false);
  });

  it('the reported case: a real question typed mid-setup interrupts, a bare price does not', () => {
    expect(isFlowInterruption(parseIntent('analyse btc for me.'))).toBe(true);
    // a bare number is a strike answer — it must feed the wizard, not interrupt it
    expect(isFlowInterruption(parseIntent('63800'))).toBe(false);
  });
});

describe('parseIntent — vault_deposit', () => {
  it('deposit asks with an amount → vault_deposit carrying the amount', () => {
    const cases: [string, number][] = [
      ['add 10 dusdc to the vault', 10],
      ['add 10 to the vault', 10],
      ['deposit 25 into the liquidity pool', 25],
      ['supply the pool with 50 dusdc', 50],
      ['put $100 in the vault', 100],
      ['add 1,000 dusdc to the vault', 1000],
      ['top up the vault with 5.5', 5.5],
      // "move" is a vault deposit here (destination named), not a ticket adjustment.
      ['move 10 to the vault', 10],
    ];
    for (const [msg, amount] of cases) {
      const i = parseIntent(msg);
      expect(i.kind, msg).toBe('vault_deposit');
      if (i.kind === 'vault_deposit') expect(i.amount, msg).toBe(amount);
    }
  });

  it('a deposit ask with no amount → vault_deposit, amount undefined (Kelly asks)', () => {
    for (const msg of ['add to the vault', 'provide liquidity', 'supply the liquidity pool']) {
      const i = parseIntent(msg);
      expect(i.kind, msg).toBe('vault_deposit');
      if (i.kind === 'vault_deposit') expect(i.amount, msg).toBeUndefined();
    }
  });

  it('definitional vault asks stay the glossary, not a deposit', () => {
    for (const msg of ['what is the vault', 'how does the liquidity pool work', 'explain the vault']) {
      expect(parseIntent(msg).kind, msg).toBe('explain');
    }
  });

  it('withdrawals / removals are not a deposit (fall through)', () => {
    for (const msg of ['withdraw 10 from the vault', 'remove my liquidity', 'cancel my vault deposit']) {
      expect(parseIntent(msg).kind, msg).not.toBe('vault_deposit');
    }
  });

  it('a vault mention is a deposit, never a mistaken bet confirmation', () => {
    // The place-confirmation guard: "put 10 dusdc in the vault" must NOT read as
    // "confirm the pending bet with 10 dusdc" — it routes to a vault deposit instead.
    expect(placeConfirmation('put 10 dusdc in the vault')).toBeNull();
    expect(isPlaceConfirmation('add 10 dusdc to the vault')).toBe(false);
    expect(parseIntent('put 10 dusdc in the vault').kind).toBe('vault_deposit');
  });
});

describe('parseIntent — memory (remember / recall)', () => {
  it('"remember that I ..." → remember, carrying the fact in original casing', () => {
    const cases: [string, string][] = [
      ['remember that I prefer safer up bets', 'I prefer safer up bets'],
      ['remember I like BTC 1h markets', 'I like BTC 1h markets'],
      ['kelly, remember I avoid leverage', 'I avoid leverage'],
      ['note that I trade mornings', 'I trade mornings'],
      ['keep in mind I hate longshots', 'I hate longshots'],
    ];
    for (const [msg, text] of cases) {
      const i = parseIntent(msg);
      expect(i.kind, msg).toBe('remember');
      if (i.kind === 'remember') expect(i.text, msg).toBe(text);
    }
  });

  it('"what do you remember/know about me" → recall_memory', () => {
    for (const msg of [
      'what do you remember about me',
      'what do you know about me',
      'what have you learned about me',
      'do you remember me',
      'what are my saved preferences',
    ]) {
      expect(parseIntent(msg).kind, msg).toBe('recall_memory');
    }
  });

  it('a recall question never stores (recall wins over remember)', () => {
    const i = parseIntent('what do you remember about me');
    expect(i.kind).toBe('recall_memory');
  });

  it('bare "remember me" does not store a junk one-word fact', () => {
    expect(parseIntent('remember me').kind).not.toBe('remember');
  });

  it('does not fire on unrelated messages', () => {
    for (const msg of ['set up a trade', 'safe up bet', 'analyze btc', "what's my win rate", 'what do you know about btc']) {
      const k = parseIntent(msg).kind;
      expect(k, msg).not.toBe('remember');
      expect(k, msg).not.toBe('recall_memory');
    }
  });
});
