import { describe, it, expect } from 'vitest';
import { respondToIntent, timeLeftLabel, type CopilotContext, type BetCandidate } from './respond';
import type { SviFloat } from '@/lib/svi/svi';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { Oracle } from '@/lib/api/types';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const NOW = 1_700_000_000_000;

function candidate(id: string, minutesOut: number, forward = 65_000): BetCandidate {
  const market = { expiry_market_id: id, expiry: NOW + minutesOut * 60_000, admission_tick_size: '1000000000', tick_size: '1', max_admission_leverage: 3_000_000_000, base_fee: '0' } as unknown as V2Market;
  const pricer: LivePricer = { expiryMarketId: id, forward, svi: SVI };
  return { market, pricer };
}

const INSIGHTS: BtcInsights = {
  available: true,
  asOf: NOW,
  spot: 65_000,
  change24hPct: 1.8, // clearly bullish
  oiUsd: 50e9,
  funding: { binancePct: 0.01, avgPct: 0.01 },
  liq24h: { totalUsd: 30e6, longUsd: 8e6, shortUsd: 22e6 }, // shorts hit → up
  maxPain: { strike: 65_500, date: '2026-07-22' },
  sentiment: { value: 62, label: 'Greed' },
};

const ctx = (over: Partial<CopilotContext> = {}): CopilotContext => ({
  insights: INSIGHTS,
  candidates: [candidate('m-soon', 4), candidate('m-hour', 58)],
  now: NOW,
  ...over,
});

describe('respondToIntent — analyze', () => {
  it('returns a plain read and no bet', () => {
    const r = respondToIntent({ kind: 'analyze' }, ctx());
    expect(r.bet).toBeUndefined();
    expect(r.text.length).toBeGreaterThan(1);
    expect(r.text.join(' ')).toMatch(/soonest market/i);
  });

  it('falls back gracefully when insights are unavailable', () => {
    const r = respondToIntent({ kind: 'analyze' }, ctx({ insights: null }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/market data/i);
  });
});

describe('respondToIntent — next market', () => {
  it('returns the soonest market details (time + current price), no bet', () => {
    const r = respondToIntent({ kind: 'next_market' }, ctx());
    expect(r.bet).toBeUndefined();
    const blob = r.text.join(' ');
    expect(blob).toMatch(/next market settles/i);
    expect(blob).toMatch(/65,000/); // current price shown
  });

  it('no live market → honest note', () => {
    const r = respondToIntent({ kind: 'next_market' }, ctx({ candidates: [] }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/no live market/i);
  });

  it('shows the live spot (matching the tape) as "now", not the forward', () => {
    // forward is 65,000; the tape's spot is 64,900 → the co-pilot must quote 64,900.
    const r = respondToIntent({ kind: 'next_market' }, ctx({ spot: 64_900 }));
    const blob = r.text.join(' ');
    expect(blob).toMatch(/64,900/);
    expect(blob).not.toMatch(/65,000/);
  });
});

describe('respondToIntent — directional bet', () => {
  it('quotes the live spot as the current price, not the forward', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'soonest' }, ctx({ spot: 64_900 }));
    expect(r.text.join(' ')).toMatch(/around \$64,900 now/);
  });

  it('safe UP → strike below forward, high odds, small payout', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx());
    expect(r.bet).toBeDefined();
    const b = r.bet!;
    expect(b.dir).toBe('up');
    expect(b.isUp).toBe(true);
    expect(b.marketId).toBe('m-soon');
    expect(b.strikePrice).toBeLessThan(65_000); // safer UP sits below the price
    expect(b.prob).toBeGreaterThan(0.6);
    expect(b.payoutMult).toBeGreaterThan(1);
    expect(b.payoutMult).toBeLessThan(1.7);
  });

  it('longshot UP → strike above forward, lower odds, bigger payout', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'longshot', horizon: 'soonest' }, ctx());
    const b = r.bet!;
    expect(b.strikePrice).toBeGreaterThan(65_000);
    expect(b.prob).toBeLessThan(0.4);
    expect(b.payoutMult).toBeGreaterThan(2.5);
  });

  it('DOWN bet sets isUp false', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'down', conviction: 'even', horizon: 'soonest' }, ctx());
    expect(r.bet!.isUp).toBe(false);
  });

  it('horizon "hour" picks the ~1h market', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'hour' }, ctx());
    expect(r.bet!.marketId).toBe('m-hour');
  });

  it('bullish context → an UP bet reads as aligned', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx());
    expect(r.text.join(' ')).toMatch(/leaning the same way/i);
  });

  it('no live market → no bet, honest note', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx({ candidates: [] }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/no live market/i);
  });
});

describe('respondToIntent — recommendation (a steer, not advice)', () => {
  it('leads with an UP steer when the data is bullish, backs it with the read, flags not-advice', () => {
    const r = respondToIntent({ kind: 'recommend' }, ctx()); // fixture leans bullish
    const blob = r.text.join(' ');
    expect(blob).toMatch(/up bet/i);
    expect(blob).toMatch(/not financial advice/i);
    expect(blob).toMatch(/soonest|leaning|liquidat|sentiment|24h/i); // the supporting read
  });

  it('leans DOWN when the data is bearish', () => {
    const bear = { ...INSIGHTS, change24hPct: -1.8, sentiment: { value: 30, label: 'Fear' }, liq24h: { totalUsd: 30e6, longUsd: 22e6, shortUsd: 8e6 } };
    const r = respondToIntent({ kind: 'recommend' }, ctx({ insights: bear }));
    expect(r.text.join(' ')).toMatch(/down bet/i);
  });

  it('suggests a RANGE when there is no clear direction', () => {
    const flat = { ...INSIGHTS, change24hPct: 0.05, sentiment: { value: 50, label: 'Neutral' }, liq24h: { totalUsd: 20e6, longUsd: 10e6, shortUsd: 10e6 } };
    const r = respondToIntent({ kind: 'recommend' }, ctx({ insights: flat }));
    const blob = r.text.join(' ');
    expect(blob).toMatch(/range bet/i);
    expect(blob).not.toMatch(/up bet|down bet/i);
  });

  it('honest fallback when insights are unavailable', () => {
    const r = respondToIntent({ kind: 'recommend' }, ctx({ insights: null }));
    expect(r.text.join(' ')).toMatch(/steer|market data|moment/i);
  });
});

describe('respondToIntent — analyze closes with a soft recommendation', () => {
  it('ends the read with a not-advice steer', () => {
    const r = respondToIntent({ kind: 'analyze' }, ctx());
    const blob = r.text.join(' ');
    expect(blob).toMatch(/not financial advice/i);
    expect(blob).toMatch(/up bet|down bet|range bet/i);
  });
});

describe('respondToIntent — metric (focused answers)', () => {
  it('fear & greed → the index number + label, not the full read', () => {
    const r = respondToIntent({ kind: 'metric', metric: 'fear_greed' }, ctx());
    expect(r.bet).toBeUndefined();
    const blob = r.text.join(' ');
    expect(blob).toMatch(/fear\s*&\s*greed/i);
    expect(blob).toMatch(/62\/100/); // the fixture's sentiment value
    expect(blob).toMatch(/greed/i); // the fixture's label
    // Focused — it must NOT dump the trend/liquidation lines of the full read.
    expect(blob).not.toMatch(/liquidat/i);
  });

  it('funding → a focused funding line', () => {
    const r = respondToIntent({ kind: 'metric', metric: 'funding' }, ctx());
    expect(r.text.join(' ')).toMatch(/funding/i);
  });

  it('liquidations → a focused liquidation line', () => {
    const r = respondToIntent({ kind: 'metric', metric: 'liquidations' }, ctx());
    expect(r.text.join(' ')).toMatch(/liquidat/i);
  });

  it('max pain → the max-pain price', () => {
    const r = respondToIntent({ kind: 'metric', metric: 'max_pain' }, ctx());
    expect(r.text.join(' ')).toMatch(/max.?pain/i);
    expect(r.text.join(' ')).toMatch(/65,500/); // the fixture's maxPain strike
  });

  it('honest fallback when insights are unavailable', () => {
    const r = respondToIntent({ kind: 'metric', metric: 'fear_greed' }, ctx({ insights: null }));
    expect(r.text.join(' ')).toMatch(/market data|moment/i);
  });

  it('price / 24h / open interest focused answers', () => {
    expect(respondToIntent({ kind: 'metric', metric: 'price' }, ctx({ spot: 65_961 })).text.join(' ')).toMatch(/\$65,961/);
    expect(respondToIntent({ kind: 'metric', metric: 'change_24h' }, ctx()).text.join(' ')).toMatch(/24h/i);
    expect(respondToIntent({ kind: 'metric', metric: 'open_interest' }, ctx()).text.join(' ')).toMatch(/open interest/i);
  });
});

describe('respondToIntent — odds & payout', () => {
  it('odds at a strike with a side → chance + payout + a loadable bet', () => {
    const r = respondToIntent({ kind: 'odds', level: { kind: 'strike', price: 66_500 }, dir: 'up' }, ctx({ spot: 65_000 }));
    expect(r.text.join(' ')).toMatch(/chance|%/);
    expect(r.text.join(' ')).toMatch(/pays about/i);
    expect(r.bet).toBeDefined();
    expect(r.bet!.isUp).toBe(true);
    expect(r.bet!.strikePrice).toBeCloseTo(66_500, -2);
  });

  it('a % move resolves to a strike off spot and loads a bet', () => {
    const r = respondToIntent({ kind: 'odds', level: { kind: 'move', pct: 1 }, dir: 'up' }, ctx({ spot: 65_000 }));
    expect(r.bet).toBeDefined();
    expect(r.bet!.strikePrice).toBeGreaterThan(65_000); // a 1% up move
  });

  it('a bare strike (no side) shows BOTH sides and loads no bet', () => {
    const r = respondToIntent({ kind: 'odds', level: { kind: 'strike', price: 65_000 } }, ctx({ spot: 65_000 }));
    expect(r.bet).toBeUndefined();
    const blob = r.text.join(' ');
    expect(blob).toMatch(/above/i);
    expect(blob).toMatch(/at or below/i);
  });

  it('an explicit 70% target lands near 70% odds', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'soonest', target: { kind: 'prob', value: 0.7 } }, ctx({ spot: 65_000 }));
    expect(r.bet!.prob).toBeGreaterThan(0.6);
    expect(r.bet!.prob).toBeLessThan(0.8);
  });

  it('"double my money" targets a ~2x payout', () => {
    const r = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'soonest', target: { kind: 'payout', mult: 2 } }, ctx({ spot: 65_000 }));
    expect(r.bet!.payoutMult).toBeGreaterThan(1.7);
    expect(r.bet!.payoutMult).toBeLessThan(2.4);
  });
});

describe('respondToIntent — balance', () => {
  // toQuote(6dec): $250 = 250_000_000n, $40 = 40_000_000n.
  const funded = { connected: true, hasAccount: true, accountBase: 250_000_000n, walletBase: 40_000_000n };

  it('shows the DUSDC total split across trading account + wallet', () => {
    const r = respondToIntent({ kind: 'balance' }, ctx({ wallet: funded }));
    const blob = r.text.join(' ');
    expect(blob).toMatch(/\$290\.00/); // total
    expect(blob).toMatch(/\$250\.00/); // trading account
    expect(blob).toMatch(/\$40\.00/); // wallet
    expect(blob).toMatch(/dusdc/i);
  });

  it('when there is no trading account yet, shows the wallet balance', () => {
    const r = respondToIntent({ kind: 'balance' }, ctx({ wallet: { connected: true, hasAccount: false, accountBase: 0n, walletBase: 15_000_000n } }));
    const blob = r.text.join(' ');
    expect(blob).toMatch(/\$15\.00/);
    expect(blob).toMatch(/wallet/i);
  });

  it('zero balance → nudges toward the faucet', () => {
    const r = respondToIntent({ kind: 'balance' }, ctx({ wallet: { connected: true, hasAccount: false, accountBase: 0n, walletBase: 0n } }));
    expect(r.text.join(' ')).toMatch(/\$0\.00|faucet/i);
  });

  it('not connected → asks them to connect', () => {
    const r = respondToIntent({ kind: 'balance' }, ctx({ wallet: { connected: false, hasAccount: false, accountBase: 0n, walletBase: undefined } }));
    expect(r.text.join(' ')).toMatch(/connect/i);
  });

  it('still loading → asks to try again', () => {
    const r = respondToIntent({ kind: 'balance' }, ctx({ wallet: { connected: true, hasAccount: true, accountBase: 0n, walletBase: undefined } }));
    expect(r.text.join(' ')).toMatch(/loading|moment/i);
  });
});

describe('respondToIntent — surface-native analysis', () => {
  // Realistic-ish smiles: total variance grows with tenor, so the 1σ move and the
  // chance of a fixed move both rise with time (a real term structure).
  const smile = (id: string, min: number, sigma: number) => ({
    market: { expiry_market_id: id, expiry: NOW + min * 60_000, admission_tick_size: '1000000000', min_entry_probability: '5000000', max_entry_probability: '995000000', max_admission_leverage: 3_000_000_000, tick_size: '1', base_fee: '0' } as unknown as V2Market,
    pricer: { expiryMarketId: id, forward: 66_000, svi: { a: 0, b: 0.02, rho: -0.2, m: 0, sigma } } as LivePricer,
  });
  const cands = [smile('m1', 1, 0.02), smile('m5', 5, 0.05), smile('m60', 60, 0.15)];
  const sctx = { insights: INSIGHTS, candidates: cands, now: NOW, spot: 66_000 };

  it('volatility → a concrete ± band, no meaningless annualized figure', () => {
    const r = respondToIntent({ kind: 'volatility' }, sctx);
    const blob = r.text.join(' ');
    expect(blob).toMatch(/typical swing of about ±\$/);
    expect(blob).toMatch(/2-in-3/);
    expect(blob).not.toMatch(/annualiz/i);
  });

  it('skew → drop-vs-pop comparison and a lean', () => {
    const r = respondToIntent({ kind: 'skew' }, sctx);
    const blob = r.text.join(' ');
    expect(blob).toMatch(/1% drop/);
    expect(blob).toMatch(/1% pop/);
    expect(blob).toMatch(/downside|upside|balanced/i);
  });

  it('term structure → the move gets more likely with a longer expiry', () => {
    const r = respondToIntent({ kind: 'term_structure', dir: 'up' }, sctx);
    const nums = r.text.join(' ').match(/about (\d+)%/g)!.map((s) => parseInt(s.replace(/\D/g, ''), 10));
    expect(nums.length).toBe(3);
    expect(nums[0]).toBeLessThan(nums[2]); // longer expiry → higher chance of the move
  });

  it('no-arb → clean when the surface is well-formed', () => {
    const inputs = cands.map((c) => ({ oracle: { oracle_id: c.market.expiry_market_id, expiry: c.market.expiry, underlying_asset: 'BTC' } as unknown as Oracle, svi: c.pricer.svi, forward: c.pricer.forward }));
    const r = respondToIntent({ kind: 'no_arb' }, { ...sctx, surfaceInputs: inputs });
    expect(r.text.join(' ')).toMatch(/clean|no arbitrage/i);
  });

  it('no-arb → asks for more expiries when it can\'t build a surface', () => {
    const r = respondToIntent({ kind: 'no_arb' }, sctx); // no surfaceInputs
    expect(r.text.join(' ')).toMatch(/couple of live expiries|check back/i);
  });

  // Deterministic upward-drifting tape, so a small up move has a real base rate.
  const CLOSES = Array.from({ length: 300 }, (_, i) => 66_000 * (1 + 0.0004 * i));

  it('reality check → surface odds vs the empirical base rate', () => {
    const r = respondToIntent({ kind: 'reality_check', level: { kind: 'move', pct: 0.5 }, dir: 'up' }, { ...sctx, closes: CLOSES });
    const blob = r.text.join(' ');
    expect(blob).toMatch(/surface prices it at about \d+%/);
    expect(blob).toMatch(/landed there about \d+% of the time/);
    expect(blob).toMatch(/not financial advice/i);
  });

  it('reality check → honest fallback without price history', () => {
    const r = respondToIntent({ kind: 'reality_check', level: { kind: 'move', pct: 1 }, dir: 'up' }, { ...sctx, closes: null });
    expect(r.text.join(' ')).toMatch(/history|moment/i);
  });
});

describe('respondToIntent — portfolio (how am I doing + balances)', () => {
  const funded = { connected: true, hasAccount: true, accountBase: 250_000_000n, walletBase: 40_000_000n };
  const PF = {
    openCount: 2,
    openValue: 120,
    openExposure: 100,
    unrealized: 20,
    unrealizedPct: 0.2,
    claimable: 0,
    claimableCount: 0,
    settledLostCount: 0,
    best: { label: 'UP $65,000', pnl: 15 },
    worst: { label: 'DOWN $64,000', pnl: 5 },
  };

  it('summarizes open bets, their PnL, and the free balance', () => {
    const r = respondToIntent({ kind: 'portfolio' }, ctx({ wallet: funded, portfolio: PF }));
    const blob = r.text.join(' ');
    expect(blob).toMatch(/2 open bets/);
    expect(blob).toMatch(/\$120\.00/); // current value
    expect(blob).toMatch(/\+\$20\.00/); // unrealized PnL
    expect(blob).toMatch(/\$290\.00/); // free balance total (account + wallet)
  });

  it('surfaces claimable winnings when there are settled wins', () => {
    const r = respondToIntent(
      { kind: 'portfolio' },
      ctx({ wallet: funded, portfolio: { ...PF, claimable: 33, claimableCount: 1 } }),
    );
    expect(r.text.join(' ')).toMatch(/waiting to be claimed/i);
  });

  it('no open bets → says so and shows the balance', () => {
    const r = respondToIntent(
      { kind: 'portfolio' },
      ctx({ wallet: funded, portfolio: { ...PF, openCount: 0, openValue: 0, openExposure: 0, unrealized: 0, best: undefined, worst: undefined } }),
    );
    const blob = r.text.join(' ');
    expect(blob).toMatch(/don't have any open bets/i);
    expect(blob).toMatch(/\$290\.00|ready to trade/);
  });

  it('not connected → asks them to connect', () => {
    const r = respondToIntent({ kind: 'portfolio' }, ctx({ wallet: { connected: false, hasAccount: false, accountBase: 0n, walletBase: undefined } }));
    expect(r.text.join(' ')).toMatch(/connect/i);
  });
});

describe('respondToIntent — analyze the current strike', () => {
  const CLOSES = Array.from({ length: 300 }, (_, i) => 65_000 * (1 + 0.0004 * i)); // upward drift
  const selection = { marketId: 'm-soon', strikePrice: 65_325, isUp: true }; // a ~0.5% up move

  it('reads the selected strike: surface odds, payout, reality check, market context', () => {
    const r = respondToIntent({ kind: 'analyze_strike' }, ctx({ selection, spot: 65_000, closes: CLOSES }));
    const blob = r.text.join(' ');
    expect(blob).toMatch(/UP \$65,325/);
    expect(blob).toMatch(/surface prices it at about \d+%/);
    expect(blob).toMatch(/paying ~\d/);
    expect(blob).toMatch(/landed there about \d+% of the time/);
    expect(blob).toMatch(/not financial advice/i);
    expect(r.bet).toBeUndefined(); // a read, not a loaded bet
  });

  it('falls back to the at-the-money strike when nothing is selected', () => {
    const r = respondToIntent({ kind: 'analyze_strike' }, ctx({ selection: null, spot: 65_000 }));
    expect(r.text.join(' ')).toMatch(/UP \$/);
    expect(r.text.join(' ')).toMatch(/surface prices it/);
  });

  it('no live market → honest fallback', () => {
    const r = respondToIntent({ kind: 'analyze_strike' }, ctx({ candidates: [] }));
    expect(r.text.join(' ')).toMatch(/no live market/i);
  });
});

describe('respondToIntent — find a strike on the surface', () => {
  it('snaps the strike, returns a highlight, and quotes both sides', () => {
    const r = respondToIntent({ kind: 'find_strike', price: 65_200 }, ctx());
    const blob = r.text.join(' ');
    expect(blob).toMatch(/Found it — \$65,200/);
    expect(blob).toMatch(/highlighted it on the surface/i);
    expect(blob).toMatch(/Above — about \d+%/);
    expect(r.highlight).toBeDefined();
    expect(r.highlight!.marketId).toBe('m-soon');
    expect(r.highlight!.strikePrice).toBeCloseTo(65_200, -1);
    expect(r.bet).toBeUndefined(); // a locate, not a bet suggestion
  });

  it('carries the named direction into the highlight', () => {
    expect(respondToIntent({ kind: 'find_strike', price: 65_200, dir: 'up' }, ctx()).highlight!.isUp).toBe(true);
    // Default (no direction): the more-likely side — a strike above spot leans DOWN.
    expect(respondToIntent({ kind: 'find_strike', price: 65_200 }, ctx()).highlight!.isUp).toBe(false);
  });

  it('a strike far from spot is still highlighted, with a heads-up', () => {
    const r = respondToIntent({ kind: 'find_strike', price: 90_000 }, ctx());
    expect(r.highlight).toBeDefined();
    expect(r.text.join(' ')).toMatch(/highlighted it on the surface|far out|long shot|almost/i);
  });

  it('no live market → honest fallback, no highlight', () => {
    const r = respondToIntent({ kind: 'find_strike', price: 65_200 }, ctx({ candidates: [] }));
    expect(r.highlight).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/no live market/i);
  });
});

describe('respondToIntent — explain (glossary)', () => {
  it('answers each topic with plain text, no bet or highlight', () => {
    for (const topic of ['leverage', 'range', 'binary', 'settlement', 'loss', 'fees', 'funds', 'payout', 'predict'] as const) {
      const r = respondToIntent({ kind: 'explain', topic }, ctx());
      expect(r.text.length, topic).toBeGreaterThan(0);
      expect(r.bet, topic).toBeUndefined();
    }
    expect(respondToIntent({ kind: 'explain', topic: 'leverage' }, ctx()).text.join(' ')).toMatch(/leverage/i);
    expect(respondToIntent({ kind: 'explain', topic: 'fees' }, ctx()).text.join(' ')).toMatch(/fee|2%/i);
  });
});

describe('respondToIntent — best value', () => {
  const CLOSES = Array.from({ length: 400 }, (_, i) => 65_000 * (1 + 0.0003 * i)); // steady upward drift

  it('with price history → a value read (highlights a strike, or says nothing stands out)', () => {
    const r = respondToIntent({ kind: 'best_value' }, ctx({ spot: 65_000, closes: CLOSES }));
    expect(r.text.join(' ')).toMatch(/value/i);
    if (r.highlight) expect(r.highlight.marketId).toBe('m-soon');
  });

  it('without price history → asks to wait', () => {
    expect(respondToIntent({ kind: 'best_value' }, ctx({ closes: null })).text.join(' ')).toMatch(/history|moment/i);
  });
});

describe('respondToIntent — adjust the current bet', () => {
  const sel = { marketId: 'm-soon', strikePrice: 65_000, isUp: true, stake: 5, leverage: 1 };

  it('changes the stake and re-quotes into an updated bet', () => {
    const r = respondToIntent({ kind: 'adjust_ticket', stake: 20 }, ctx({ selection: sel }));
    expect(r.text.join(' ')).toMatch(/Updated/);
    expect(r.bet).toBeDefined();
    expect(r.bet!.amount).toBe(20);
  });

  it('flips the direction', () => {
    const r = respondToIntent({ kind: 'adjust_ticket', flip: true }, ctx({ selection: sel }));
    expect(r.bet!.isUp).toBe(false);
  });

  it('with no bet set up → guides to set one up first (no bet)', () => {
    const r = respondToIntent({ kind: 'adjust_ticket', stake: 20 }, ctx({ selection: null }));
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/set up a bet|set up a trade/i);
  });
});

describe('respondToIntent — help', () => {
  it('returns guidance, no bet', () => {
    const r = respondToIntent({ kind: 'help' }, ctx());
    expect(r.bet).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/co-pilot/i);
  });
});

describe('plain language (no trader jargon)', () => {
  const BANNED = ['edge', 'basis point', 'sigma', 'implied vol', 'skew', 'delta', 'gamma', 'tape', 'moneyness', 'theta'];
  it('every reply avoids jargon', () => {
    const replies = [
      respondToIntent({ kind: 'analyze' }, ctx()),
      respondToIntent({ kind: 'next_market' }, ctx()),
      respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'safe', horizon: 'soonest' }, ctx()),
      respondToIntent({ kind: 'directional_bet', dir: 'down', conviction: 'longshot', horizon: 'hour' }, ctx()),
      respondToIntent({ kind: 'metric', metric: 'fear_greed' }, ctx()),
      respondToIntent({ kind: 'metric', metric: 'funding' }, ctx()),
      respondToIntent({ kind: 'metric', metric: 'liquidations' }, ctx()),
      respondToIntent({ kind: 'metric', metric: 'max_pain' }, ctx()),
      respondToIntent({ kind: 'metric', metric: 'price' }, ctx({ spot: 65_000 })),
      respondToIntent({ kind: 'metric', metric: 'change_24h' }, ctx()),
      respondToIntent({ kind: 'metric', metric: 'open_interest' }, ctx()),
      respondToIntent({ kind: 'odds', level: { kind: 'strike', price: 66_000 }, dir: 'up' }, ctx()),
      respondToIntent({ kind: 'odds', level: { kind: 'strike', price: 66_000 } }, ctx()),
      respondToIntent({ kind: 'volatility' }, ctx()),
      respondToIntent({ kind: 'skew' }, ctx()),
      respondToIntent({ kind: 'term_structure' }, ctx()),
      respondToIntent({ kind: 'no_arb' }, ctx()),
      respondToIntent({ kind: 'reality_check', level: { kind: 'move', pct: 0.5 }, dir: 'up' }, ctx({ closes: Array.from({ length: 300 }, (_, i) => 66_000 * (1 + 0.0004 * i)) })),
      respondToIntent({ kind: 'recommend' }, ctx()),
      respondToIntent({ kind: 'balance' }, ctx({ wallet: { connected: true, hasAccount: true, accountBase: 250_000_000n, walletBase: 40_000_000n } })),
      respondToIntent(
        { kind: 'portfolio' },
        ctx({
          wallet: { connected: true, hasAccount: true, accountBase: 250_000_000n, walletBase: 40_000_000n },
          portfolio: { openCount: 2, openValue: 120, openExposure: 100, unrealized: 20, unrealizedPct: 0.2, claimable: 33, claimableCount: 1, settledLostCount: 0, best: { label: 'UP $65,000', pnl: 15 }, worst: { label: 'DOWN $64,000', pnl: 5 } },
        }),
      ),
      respondToIntent(
        { kind: 'analyze_strike' },
        ctx({ selection: { marketId: 'm-soon', strikePrice: 65_325, isUp: true }, spot: 65_000, closes: Array.from({ length: 300 }, (_, i) => 65_000 * (1 + 0.0004 * i)) }),
      ),
      respondToIntent({ kind: 'find_strike', price: 65_200 }, ctx()),
      respondToIntent({ kind: 'explain', topic: 'leverage' }, ctx()),
      respondToIntent({ kind: 'explain', topic: 'fees' }, ctx()),
      respondToIntent({ kind: 'explain', topic: 'predict' }, ctx()),
      respondToIntent({ kind: 'best_value' }, ctx({ spot: 65_000, closes: Array.from({ length: 400 }, (_, i) => 65_000 * (1 + 0.0003 * i)) })),
      respondToIntent({ kind: 'adjust_ticket', stake: 20, leverage: 2 }, ctx({ selection: { marketId: 'm-soon', strikePrice: 65_000, isUp: true, stake: 5, leverage: 1 } })),
      respondToIntent({ kind: 'help' }, ctx()),
    ];
    for (const r of replies) {
      const blob = r.text.join(' ').toLowerCase();
      for (const w of BANNED) expect(blob, w).not.toContain(w);
    }
  });
});

describe('timeLeftLabel', () => {
  it('reads plainly', () => {
    expect(timeLeftLabel(NOW + 30_000, NOW)).toBe('under a minute');
    expect(timeLeftLabel(NOW + 60_000, NOW)).toBe('about a minute');
    expect(timeLeftLabel(NOW + 4 * 60_000, NOW)).toBe('about 4 minutes');
    expect(timeLeftLabel(NOW + 60 * 60_000, NOW)).toBe('about an hour');
  });
});
