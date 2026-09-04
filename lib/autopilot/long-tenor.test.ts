/**
 * The long-tenor safety case.
 *
 * Autopilot's three tenor names were written when every listed market settled within the
 * hour, so "anything longer" and "today" were the same set and an unbounded `today` bucket
 * was correct. 8-21 lists 1-day and 1-week markets. Checked live on 2026-08-31, the venue
 * had markets settling in 0.3, 1.3, 2.3 and **9.3 days**.
 *
 * Under the old classifier every one of those read as 'today'. A trader who ticked "today"
 * in their rules, meaning a bet that resolves this afternoon, would have had Autopilot place
 * a nine-day unattended bet with their money, while the plan card told them it settled
 * today. Nothing would have errored. They would simply have consented to something other
 * than what happened.
 *
 * These are the numbers from that live read, so this test is about a real market that
 * existed, not a hypothetical.
 */
import { describe, it, expect } from 'vitest';
import { classifyTenor, gateTrade, TENOR_BUCKETS, type ProposedTrade } from './policy';
import type { AutopilotRules, AutopilotLimits, AutopilotRuntime } from './policy';

const NOW = 1_756_600_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The live 8-21 tenors, in ms of time remaining. */
const LIVE = {
  fiveMin: 5 * 60_000,
  oneHour: HOUR,
  sevenHours: 7.2 * HOUR, // a 1d market late in its life
  oneDay: 1.3 * DAY,
  twoDays: 2.3 * DAY,
  nineDays: 9.3 * DAY,
};

describe('classifyTenor with 1d and 1w markets listed', () => {
  it('still names the short windows exactly as before', () => {
    // The migration must not move anything a trader already understands.
    expect(classifyTenor(LIVE.fiveMin)).toBe('soonest');
    expect(classifyTenor(LIVE.oneHour)).toBe('hour');
    expect(classifyTenor(TENOR_BUCKETS.soonestMaxMs)).toBe('soonest');
    expect(classifyTenor(TENOR_BUCKETS.hourMaxMs)).toBe('hour');
  });

  it('counts a market late in its life by TIME LEFT, not by the cadence it was listed as', () => {
    // A 1-day market with seven hours on it genuinely does settle today, so it belongs in
    // 'today'. What matters is what the bet is now, not how it was created.
    expect(classifyTenor(LIVE.sevenHours)).toBe('today');
    expect(classifyTenor(TENOR_BUCKETS.todayMaxMs)).toBe('today');
  });

  it('refuses to call a multi-day market "today"', () => {
    // The whole point. Each of these was live on 8-21 and each would have been 'today'.
    // Since 2026-09-04 they have windows of their own, which a trader opts into by name.
    expect(classifyTenor(LIVE.oneDay)).toBe('day');
    expect(classifyTenor(LIVE.twoDays)).toBe('week');
    expect(classifyTenor(LIVE.nineDays)).toBe('week');
    for (const ms of [LIVE.oneDay, LIVE.twoDays, LIVE.nineDays]) expect(classifyTenor(ms)).not.toBe('today');
  });
});

describe('the gate on a nine-day market', () => {
  const rules: AutopilotRules = {
    minProb: 0.5,
    minEdge: 0,
    // Every window the trader can name. Even opting into all of them must not reach a
    // market that settles next week.
    tenors: ['soonest', 'hour', 'today'],
    sides: ['up', 'down', 'range'],
    maxLeverage: 1,
  };
  const limits: AutopilotLimits = {
    budgetUsd: 1000,
    perTradeUsd: 10,
    maxTrades: 20,
    maxConcurrent: 5,
    cooldownMs: 0,
    armDurationMs: HOUR,
    maxConsecutiveLosses: 10,
  };
  const runtime: AutopilotRuntime = {
    armedAt: NOW,
    spentUsd: 0,
    tradeCount: 0,
    openCount: 0,
    consecutiveLosses: 0,
    lastTradeAt: null,
    firedMarkets: {},
  };
  const trade = (msLeft: number): ProposedTrade => ({
    kind: 'binary',
    marketId: '0xm',
    expiry: NOW + msLeft,
    prob: 0.8,
    edge: 0.1,
    side: 'up',
    leverage: 1,
    sizeUsd: 10,
  });

  it('allows it once the trader has opted into the weekly window, even on a one-hour run', () => {
    const res = gateTrade(trade(LIVE.nineDays), { ...rules, tenors: [...rules.tenors, 'week'] }, limits, runtime, NOW);
    expect(res.allow).toBe(true);
  });

  it('denies it, with every rule otherwise satisfied', () => {
    // Probability, edge, side, leverage, pacing and budget all pass. Only the tenor stops
    // it, which is what makes this the load-bearing check rather than an incidental one.
    const res = gateTrade(trade(LIVE.nineDays), rules, limits, runtime, NOW);
    expect(res.allow).toBe(false);
    expect(res.code).toBe('tenor_not_allowed');
  });

  it('still allows the same trade on a market that really does settle today', () => {
    // Proving the fix denies by TENOR and has not just broken the gate. The seven-hour
    // market needs a session long enough to hold it: a bet must also settle before the
    // run's own clock runs out (settles_after_session), which is a separate rule.
    const longSession = { ...limits, armDurationMs: 12 * HOUR };
    expect(gateTrade(trade(LIVE.sevenHours), rules, longSession, runtime, NOW).allow).toBe(true);
    expect(gateTrade(trade(LIVE.fiveMin), rules, limits, runtime, NOW).allow).toBe(true);
  });

  it('cannot be opted into by a stored rule set naming an unknown window', () => {
    // Rules are persisted in the trader's browser. A future build that adds a longer bucket
    // must not retroactively widen what an existing saved rule set permits, so an unknown
    // name is inert rather than additive.
    // ('week' was that unknown name until 2026-09-04; it is a real window now, so the
    // stand-in is a name no build has ever defined.)
    const widened = { ...rules, tenors: [...rules.tenors, 'month'] as AutopilotRules['tenors'] };
    const res = gateTrade(trade(LIVE.nineDays), widened, limits, runtime, NOW);
    expect(res.allow).toBe(false);
    // And a market past the weekly window belongs to no window at all, whatever is stored.
    expect(gateTrade(trade(11 * DAY), { ...rules, tenors: ['soonest', 'hour', 'today', 'day', 'week'] }, limits, runtime, NOW).code).toBe('tenor_not_allowed');
  });
});
