import { describe, it, expect } from 'vitest';
import {
  classifyTenor,
  gateTrade,
  autoStopReason,
  settleOutcome,
  gateReasonLabel,
  stopReasonLabel,
  stopReasonKind,
  TENOR_BUCKETS,
  type ProposedTrade,
  type AutopilotRules,
  type AutopilotLimits,
  type AutopilotRuntime,
  type AutopilotHealth,
  type GateCode,
  type StopReason,
  stakeFor,
} from './policy';

const NOW = 1_800_000_000_000;

const rules: AutopilotRules = {
  minProb: 0.6,
  minEdge: 0,
  tenors: ['soonest', 'hour'],
  sides: ['up', 'down'],
  maxLeverage: 3,
};

const limits: AutopilotLimits = {
  budgetUsd: 50,
  perTradeUsd: 5,
  maxTrades: 8,
  maxConcurrent: 3,
  cooldownMs: 60_000,
  armDurationMs: 60 * 60_000,
  maxConsecutiveLosses: 3,
};

const runtime: AutopilotRuntime = {
  armedAt: NOW - 5 * 60_000,
  spentUsd: 10,
  tradeCount: 2,
  openCount: 1,
  consecutiveLosses: 0,
  lastTradeAt: NOW - 2 * 60_000, // past cooldown
  firedMarkets: {},
};

const health: AutopilotHealth = { sessionLive: true, gasOk: true, feedFresh: true };

/** A clean pick that passes every rule and pacing check. */
const goodTrade: ProposedTrade = {
  kind: 'binary',
  marketId: '0xmarket-a',
  expiry: NOW + 10 * 60_000, // soonest
  prob: 0.66,
  edge: 0.05,
  side: 'up',
  leverage: 2,
  sizeUsd: 5,
};

describe('classifyTenor', () => {
  it('buckets by time-to-expiry with inclusive upper edges', () => {
    expect(classifyTenor(0)).toBe('soonest');
    expect(classifyTenor(TENOR_BUCKETS.soonestMaxMs)).toBe('soonest');
    expect(classifyTenor(TENOR_BUCKETS.soonestMaxMs + 1)).toBe('hour');
    expect(classifyTenor(TENOR_BUCKETS.hourMaxMs)).toBe('hour');
    expect(classifyTenor(TENOR_BUCKETS.hourMaxMs + 1)).toBe('today');
    expect(classifyTenor(6 * 60 * 60_000)).toBe('today');
  });
});

describe('gateTrade — a clean pick', () => {
  it('allows a pick that clears every rule and pacing check', () => {
    expect(gateTrade(goodTrade, rules, limits, runtime, NOW)).toEqual({ allow: true, code: 'ok' });
  });
});

describe('gateTrade — the trader rules', () => {
  it('rejects below the win-chance floor', () => {
    expect(gateTrade({ ...goodTrade, prob: 0.59 }, rules, limits, runtime, NOW).code).toBe('below_min_prob');
    // exactly at the floor is allowed
    expect(gateTrade({ ...goodTrade, prob: 0.6 }, rules, limits, runtime, NOW).allow).toBe(true);
  });

  it('rejects below a required value edge, but only when minEdge > 0', () => {
    const strict = { ...rules, minEdge: 0.04 };
    expect(gateTrade({ ...goodTrade, edge: 0.03 }, strict, limits, runtime, NOW).code).toBe('below_min_edge');
    expect(gateTrade({ ...goodTrade, edge: 0.04 }, strict, limits, runtime, NOW).allow).toBe(true);
    // with minEdge 0 (default), a zero-edge safe pick is fine
    expect(gateTrade({ ...goodTrade, edge: 0 }, rules, limits, runtime, NOW).allow).toBe(true);
  });

  it('rejects a tenor the trader did not allow', () => {
    const longDated: ProposedTrade = { ...goodTrade, expiry: NOW + 3 * 60 * 60_000 }; // today
    expect(gateTrade(longDated, rules, limits, runtime, NOW).code).toBe('tenor_not_allowed');
    expect(gateTrade(longDated, { ...rules, tenors: ['today'] }, limits, runtime, NOW).allow).toBe(true);
  });

  it('rejects a side the trader turned off', () => {
    expect(gateTrade({ ...goodTrade, side: 'down' }, { ...rules, sides: ['up'] }, limits, runtime, NOW).code).toBe(
      'side_not_allowed',
    );
    expect(gateTrade({ ...goodTrade, side: 'range', kind: 'range' }, rules, limits, runtime, NOW).code).toBe(
      'side_not_allowed',
    );
  });

  it('rejects leverage above the cap', () => {
    expect(gateTrade({ ...goodTrade, leverage: 3.1 }, rules, limits, runtime, NOW).code).toBe('leverage_too_high');
    expect(gateTrade({ ...goodTrade, leverage: 3 }, rules, limits, runtime, NOW).allow).toBe(true);
  });

  it('checks rules before pacing (rule rejection wins when both apply)', () => {
    // over concurrency AND below prob — the trader-facing rule reason should win
    const busy = { ...runtime, openCount: 3 };
    expect(gateTrade({ ...goodTrade, prob: 0.1 }, rules, limits, busy, NOW).code).toBe('below_min_prob');
  });
});

describe('gateTrade — pacing (non-terminal, clears on its own)', () => {
  it('waits while at the open-positions limit', () => {
    expect(gateTrade(goodTrade, rules, limits, { ...runtime, openCount: 3 }, NOW).code).toBe('max_concurrent_reached');
  });

  it('waits during the cooldown between trades', () => {
    const justTraded = { ...runtime, lastTradeAt: NOW - 30_000 };
    expect(gateTrade(goodTrade, rules, limits, justTraded, NOW).code).toBe('cooldown_active');
    // exactly at the cooldown boundary is allowed
    const atBoundary = { ...runtime, lastTradeAt: NOW - limits.cooldownMs };
    expect(gateTrade(goodTrade, rules, limits, atBoundary, NOW).allow).toBe(true);
  });

  it('waits before re-firing a market it just traded', () => {
    const fired = { ...runtime, firedMarkets: { '0xmarket-a': NOW - 30_000 } };
    expect(gateTrade(goodTrade, rules, limits, fired, NOW).code).toBe('market_recently_fired');
    // a different market is unaffected
    expect(gateTrade({ ...goodTrade, marketId: '0xmarket-b' }, rules, limits, fired, NOW).allow).toBe(true);
  });

  it('allows the very first trade (no lastTradeAt yet)', () => {
    const fresh = { ...runtime, lastTradeAt: null, tradeCount: 0, openCount: 0 };
    expect(gateTrade(goodTrade, rules, limits, fresh, NOW).allow).toBe(true);
  });
});

describe('autoStopReason — terminal disarms', () => {
  it('returns null while everything is healthy and within limits', () => {
    expect(autoStopReason(limits, runtime, health, NOW)).toBeNull();
  });

  it('stops only when what is left cannot fund even the smallest trade', () => {
    // $4 left is less than a full $5 trade, but the last trade shrinks to fit (stakeFor).
    expect(autoStopReason(limits, { ...runtime, spentUsd: 46 }, health, NOW)).toBeNull();
    expect(autoStopReason(limits, { ...runtime, spentUsd: 45 }, health, NOW)).toBeNull();
    expect(autoStopReason(limits, { ...runtime, spentUsd: 49.5 }, health, NOW)).toBe('budget_spent');
    expect(autoStopReason(limits, { ...runtime, spentUsd: 50 }, health, NOW)).toBe('budget_spent');
  });

  it('sizes the last trade to whatever budget is left', () => {
    expect(stakeFor(limits, runtime)).toBe(5);
    expect(stakeFor(limits, { ...runtime, spentUsd: 46 })).toBe(4);
    expect(stakeFor(limits, { ...runtime, spentUsd: 50 })).toBe(0);
    // The $5,000 careful run that stopped after two $1,667 trades with $1,666 unspent.
    const careful = { ...limits, budgetUsd: 5000, perTradeUsd: 1667, maxTrades: 3 };
    const twoIn = { ...runtime, spentUsd: 3334, tradeCount: 2 };
    expect(stakeFor(careful, twoIn)).toBe(1666);
    expect(autoStopReason(careful, twoIn, health, NOW)).toBeNull();
  });

  it('stops at the trade cap', () => {
    expect(autoStopReason(limits, { ...runtime, tradeCount: 8 }, health, NOW)).toBe('trade_cap_reached');
  });

  it('stops after the losing-streak limit', () => {
    expect(autoStopReason(limits, { ...runtime, consecutiveLosses: 3 }, health, NOW)).toBe('loss_limit');
  });

  it('stops once the armed duration has elapsed', () => {
    const old = { ...runtime, armedAt: NOW - limits.armDurationMs };
    expect(autoStopReason(limits, old, health, NOW)).toBe('duration_elapsed');
  });

  it('stops on any machinery failure, key and feed before the routine reasons', () => {
    expect(autoStopReason(limits, runtime, { ...health, sessionLive: false }, NOW)).toBe('session_expired');
    expect(autoStopReason(limits, runtime, { ...health, gasOk: false }, NOW)).toBe('gas_low');
    expect(autoStopReason(limits, runtime, { ...health, feedFresh: false }, NOW)).toBe('feed_stall');
    // a dead session outranks a spent budget in the reported reason
    const broke = { ...runtime, spentUsd: 50 };
    expect(autoStopReason(limits, broke, { ...health, sessionLive: false }, NOW)).toBe('session_expired');
  });
});

describe('label helpers cover every code (plain language, no em-dash)', () => {
  const gateCodes: GateCode[] = [
    'ok',
    'below_min_prob',
    'below_min_edge',
    'tenor_not_allowed',
    'side_not_allowed',
    'leverage_too_high',
    'cooldown_active',
    'market_recently_fired',
    'max_concurrent_reached',
  ];
  const stopReasons: StopReason[] = [
    'budget_spent',
    'trade_cap_reached',
    'duration_elapsed',
    'loss_limit',
    'session_expired',
    'gas_low',
    'feed_stall',
  ];

  it('has a non-empty, em-dash-free label for every gate code', () => {
    for (const code of gateCodes) {
      const label = gateReasonLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain('—');
    }
  });

  it('has a non-empty, em-dash-free label for every stop reason', () => {
    for (const reason of stopReasons) {
      const label = stopReasonLabel(reason);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain('—');
    }
  });

  it('reads planned finishes as complete and trouble as attention', () => {
    expect(stopReasonKind('budget_spent')).toBe('complete');
    expect(stopReasonKind('trade_cap_reached')).toBe('complete');
    expect(stopReasonKind('duration_elapsed')).toBe('complete');
    expect(stopReasonKind('loss_limit')).toBe('attention');
    expect(stopReasonKind('session_expired')).toBe('attention');
    expect(stopReasonKind('gas_low')).toBe('attention');
    expect(stopReasonKind('feed_stall')).toBe('attention');
  });
});

describe('settleOutcome', () => {
  it('scores an UP binary: wins strictly above the strike', () => {
    expect(settleOutcome({ side: 'up', strike: 100 }, 101)).toBe(true);
    expect(settleOutcome({ side: 'up', strike: 100 }, 100)).toBe(false); // at strike = not above
    expect(settleOutcome({ side: 'up', strike: 100 }, 99)).toBe(false);
  });

  it('scores a DOWN binary: wins at or below the strike', () => {
    expect(settleOutcome({ side: 'down', strike: 100 }, 99)).toBe(true);
    expect(settleOutcome({ side: 'down', strike: 100 }, 100)).toBe(true);
    expect(settleOutcome({ side: 'down', strike: 100 }, 101)).toBe(false);
  });

  it('scores a range: wins inside (lower, higher]', () => {
    const band = { side: 'range' as const, lower: 100, higher: 110 };
    expect(settleOutcome(band, 105)).toBe(true);
    expect(settleOutcome(band, 110)).toBe(true); // upper edge included
    expect(settleOutcome(band, 100)).toBe(false); // lower edge excluded
    expect(settleOutcome(band, 111)).toBe(false);
  });
});
