import { describe, it, expect } from 'vitest';
import { sourcesFromActivity, weekStartUTC } from './from-activity';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { PastPrediction } from '@/lib/portfolio/history';
import { evaluateAll, type MetricSource } from './evaluate';
import { QUESTS } from '@/config/quests';

/** 2026-09-16 is a Wednesday, so its week starts Monday 2026-09-14. */
const WED = Date.UTC(2026, 8, 16, 12, 0, 0);
const MON = Date.UTC(2026, 8, 14, 0, 0, 0);

const DUSDC = 1_000_000; // 6 decimals, matches config/scale

const life = (s: MetricSource[]) => s.find((x) => x.window === 'lifetime')!.metrics;
const week = (s: MetricSource[]) => s.find((x) => x.window === 'week')!.metrics;

/** An UP binary mint: lower tick is the strike, higher tick is the +inf sentinel. */
function mint(over: Partial<V2OrderEvent> = {}): V2OrderEvent {
  return {
    kind: 'order_minted',
    position_root_id: '1',
    expiry_market_id: '0xmarket1',
    checkpoint_timestamp_ms: WED,
    lower_tick: '5000',
    higher_tick: String(POS_INF_TICK),
    quantity: String(100 * DUSDC),
    net_premium: String(40 * DUSDC),
    ...over,
  };
}

function redeem(over: Partial<V2OrderEvent> = {}): V2OrderEvent {
  return {
    kind: 'settled_order_redeemed',
    position_root_id: '1',
    expiry_market_id: '0xmarket1',
    checkpoint_timestamp_ms: WED + 60_000,
    quantity_closed: String(100 * DUSDC),
    payout_amount: String(100 * DUSDC),
    ...over,
  };
}

describe('weekStartUTC: the week a quest measures is the week the page counts down to', () => {
  it('is the Monday 00:00 UTC at or before now', () => {
    expect(weekStartUTC(WED)).toBe(MON);
  });

  it('a Monday belongs to its own week, not the previous one', () => {
    expect(weekStartUTC(MON)).toBe(MON);
    expect(weekStartUTC(MON + 1)).toBe(MON);
  });

  it('a Sunday night still belongs to the week that started six days earlier', () => {
    const sun = Date.UTC(2026, 8, 20, 23, 59, 59);
    expect(weekStartUTC(sun)).toBe(MON);
  });
});

describe('mints: what a bet contributes', () => {
  it('counts the trade, the staked premium and the market', () => {
    const m = life(sourcesFromActivity({ orders: [mint()], nowMs: WED }));
    expect(m.trades).toBe(1);
    expect(m.volume).toBe(40);
    expect(m.distinctMarkets).toBe(1);
    expect(m.rangeTrades).toBe(0);
  });

  it('volume is the premium staked, NOT the notional, so it agrees with the leaderboard', () => {
    // quantity is 100 and the premium 40: the board counts 40, and so must this.
    const m = life(sourcesFromActivity({ orders: [mint()], nowMs: WED }));
    expect(m.volume).toBe(40);
  });

  it('two bets on the same market are two trades but one market', () => {
    const orders = [mint(), mint({ position_root_id: '2' })];
    const m = life(sourcesFromActivity({ orders, nowMs: WED }));
    expect(m.trades).toBe(2);
    expect(m.distinctMarkets).toBe(1);
  });

  it('counts distinct markets across bets', () => {
    const orders = [mint(), mint({ position_root_id: '2', expiry_market_id: '0xmarket2' })];
    expect(life(sourcesFromActivity({ orders, nowMs: WED })).distinctMarkets).toBe(2);
  });

  it('a range mint has two finite ticks; a binary carries a sentinel', () => {
    const range = mint({ lower_tick: '5000', higher_tick: '5200' });
    expect(life(sourcesFromActivity({ orders: [range], nowMs: WED })).rangeTrades).toBe(1);
    expect(life(sourcesFromActivity({ orders: [mint()], nowMs: WED })).rangeTrades).toBe(0);
  });

  it('a DOWN binary (lower tick at the -inf sentinel) is not a range', () => {
    const down = mint({ lower_tick: '0', higher_tick: '5000' });
    expect(life(sourcesFromActivity({ orders: [down], nowMs: WED })).rangeTrades).toBe(0);
  });

  it('a mint with no ticks recorded counts as a plain bet rather than inventing a range', () => {
    const bare = mint({ lower_tick: undefined, higher_tick: undefined });
    expect(life(sourcesFromActivity({ orders: [bare], nowMs: WED })).rangeTrades).toBe(0);
  });
});

describe('redeems: only a settled close rode to the oracle', () => {
  it('a settled win counts as a win, a settled close and its profit', () => {
    const m = life(sourcesFromActivity({ orders: [mint(), redeem()], nowMs: WED }));
    expect(m.wins).toBe(1);
    expect(m.settledCloses).toBe(1);
    expect(m.netPnl).toBe(60); // paid 100 against a 40 basis
  });

  it('a settled loss is a close but not a win', () => {
    const lost = redeem({ payout_amount: '0' });
    const m = life(sourcesFromActivity({ orders: [mint(), lost], nowMs: WED }));
    expect(m.wins).toBe(0);
    expect(m.settledCloses).toBe(1);
    expect(m.netPnl).toBe(-40);
  });

  it('closing early is NOT a settled close, however profitable', () => {
    const early = redeem({
      kind: 'live_order_redeemed',
      payout_amount: undefined,
      redeem_amount: String(70 * DUSDC),
    });
    const m = life(sourcesFromActivity({ orders: [mint(), early], nowMs: WED }));
    expect(m.settledCloses).toBe(0);
    expect(m.wins).toBe(1);
    expect(m.netPnl).toBe(30);
  });

  it('a live close nets its fees the same way the history tab does', () => {
    const early = redeem({
      kind: 'live_order_redeemed',
      payout_amount: undefined,
      redeem_amount: String(70 * DUSDC),
      trading_fee: String(2 * DUSDC),
      builder_fee: String(1 * DUSDC),
    });
    expect(life(sourcesFromActivity({ orders: [mint(), early], nowMs: WED })).netPnl).toBe(27);
  });

  it('a liquidation pays nothing and is never a win', () => {
    const ko = redeem({ kind: 'liquidated_order_redeemed', payout_amount: String(99 * DUSDC) });
    const m = life(sourcesFromActivity({ orders: [mint(), ko], nowMs: WED }));
    expect(m.wins).toBe(0);
    expect(m.netPnl).toBe(-40);
  });

  it('a partial close only realizes its share of the cost basis', () => {
    const half = redeem({
      quantity_closed: String(50 * DUSDC),
      payout_amount: String(50 * DUSDC),
    });
    // half of a 40 basis is 20, against a 50 payout
    expect(life(sourcesFromActivity({ orders: [mint(), half], nowMs: WED })).netPnl).toBe(30);
  });
});

describe('windows: a weekly quest must not see last week', () => {
  const lastWeek = MON - 86_400_000;

  it('an older bet counts for lifetime and not for the week', () => {
    const old = mint({ checkpoint_timestamp_ms: lastWeek });
    const s = sourcesFromActivity({ orders: [old], nowMs: WED });
    expect(life(s).volume).toBe(40);
    expect(week(s).volume).toBe(0);
  });

  it('an empty week is a measurement of zero, not an absence', () => {
    const s = sourcesFromActivity({ orders: [], nowMs: WED });
    expect(week(s).volume).toBe(0);
    expect(week(s).trades).toBe(0);
  });

  it('a position minted last week and closed this week still nets against its real basis', () => {
    const old = mint({ checkpoint_timestamp_ms: lastWeek });
    const s = sourcesFromActivity({ orders: [old, redeem()], nowMs: WED });
    // the join reaches back to the mint even though the mint is outside the window
    expect(week(s).netPnl).toBe(60);
    expect(week(s).trades).toBe(0);
  });
});

describe('deposits: a lower bound that can under-credit but never overpay', () => {
  const orders = [mint()];

  it('says nothing at all while the account read has not landed', () => {
    const m = life(sourcesFromActivity({ orders: [], nowMs: WED }));
    expect(m.deposits).toBeUndefined();
    expect('deposits' in m).toBe(false);
  });

  it('a trade proves a deposit, whatever the account read says', () => {
    expect(life(sourcesFromActivity({ orders, nowMs: WED })).deposits).toBe(1);
  });

  it('a funded account proves a deposit with no trades', () => {
    const s = sourcesFromActivity({ orders: [], account: { known: true, funded: true }, nowMs: WED });
    expect(life(s).deposits).toBe(1);
  });

  it('a known, unfunded, untraded account reads as zero', () => {
    const s = sourcesFromActivity({ orders: [], account: { known: true, funded: false }, nowMs: WED });
    expect(life(s).deposits).toBe(0);
  });

  it('an account read that has not succeeded never reads as unfunded', () => {
    const s = sourcesFromActivity({ orders: [], account: { known: false, funded: false }, nowMs: WED });
    expect(life(s).deposits).toBeUndefined();
  });

  it('is never claimed over a week, because nothing dates a deposit', () => {
    const s = sourcesFromActivity({ orders, account: { known: true, funded: true }, nowMs: WED });
    expect('deposits' in week(s)).toBe(false);
  });
});

describe('carried-over trades from a retired deployment', () => {
  const carried: PastPrediction = {
    key: 'k',
    oracleId: '0xold',
    underlying: 'BTC',
    up: true,
    strike: 60_000,
    expiry: MON - 200_000,
    settledAt: MON - 100_000,
    result: 'won',
    contracts: 10,
    cost: 12,
    payout: 20,
    pnl: 8,
    roi: 0.66,
    entryPrice: 0.6,
    legacy: true,
  };

  it('a returning trader has made a prediction, even with an empty live log', () => {
    const m = life(sourcesFromActivity({ orders: [], legacy: [carried], nowMs: WED }));
    expect(m.trades).toBe(1);
    expect(m.volume).toBe(12);
    expect(m.wins).toBe(1);
    expect(m.netPnl).toBe(8);
    expect(m.distinctMarkets).toBe(1);
  });

  it('a carried row that closed at or after its expiry rode to settlement', () => {
    const m = life(sourcesFromActivity({ orders: [], legacy: [carried], nowMs: WED }));
    expect(m.settledCloses).toBe(1);
  });

  it('a carried row closed BEFORE its expiry was an early close', () => {
    const early = { ...carried, settledAt: carried.expiry - 1 };
    expect(life(sourcesFromActivity({ orders: [], legacy: [early], nowMs: WED })).settledCloses).toBe(0);
  });

  it('a carried row with no expiry recorded is not guessed at', () => {
    const noExpiry = { ...carried, expiry: 0 };
    expect(life(sourcesFromActivity({ orders: [], legacy: [noExpiry], nowMs: WED })).settledCloses).toBe(0);
  });

  it('a carried range counts as a range', () => {
    const range = { ...carried, band: { lower: 60_000, higher: 62_000 } };
    expect(life(sourcesFromActivity({ orders: [], legacy: [range], nowMs: WED })).rangeTrades).toBe(1);
  });

  it('carried markets merge with live ones rather than double-counting a shared id', () => {
    const same = { ...carried, oracleId: '0xmarket1' };
    const m = life(sourcesFromActivity({ orders: [mint()], legacy: [same], nowMs: WED }));
    expect(m.distinctMarkets).toBe(1);
  });

  it('a carried trade also proves a deposit', () => {
    const s = sourcesFromActivity({ orders: [], legacy: [carried], nowMs: WED });
    expect(life(s).deposits).toBe(1);
  });
});

describe('the catalog can never key off something this fold does not measure', () => {
  it('every shipped quest finds its metric in a source covering its own window', () => {
    // The guard that keeps the two halves honest. Adding a quest whose metric nothing
    // folds, or whose window no source covers, fails HERE rather than shipping a card
    // that reads "Coming soon" forever.
    const sources = sourcesFromActivity({
      orders: [mint(), redeem()],
      account: { known: true, funded: true },
      nowMs: WED,
    });
    for (const q of QUESTS) {
      const src = sources.find((s) => s.window === q.window);
      expect(src, `${q.id} has no source covering ${q.window}`).toBeDefined();
      expect(src!.metrics[q.metric], `${q.id} keys off an unmeasured "${q.metric}"`).toBeTypeOf('number');
    }
  });

  it('and the evaluator therefore scores all of them', () => {
    const sources = sourcesFromActivity({
      orders: [mint(), redeem()],
      account: { known: true, funded: true },
      nowMs: WED,
    });
    expect(evaluateAll(sources).filter((r) => r.state === 'unavailable')).toEqual([]);
  });
});
