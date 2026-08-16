import { describe, it, expect, beforeEach } from 'vitest';
import { useAutopilotStore, DEFAULT_LIMITS, DEFAULT_RULES } from './autopilot-store';
import type { ProposedTrade } from '@/lib/autopilot/policy';

const S = () => useAutopilotStore.getState();

function trade(over: Partial<ProposedTrade> = {}): ProposedTrade {
  return {
    kind: 'binary',
    marketId: '0xm',
    expiry: 5_000,
    prob: 0.66,
    edge: 0,
    side: 'up',
    leverage: 1,
    sizeUsd: 5,
    ...over,
  };
}

beforeEach(() => {
  // Singleton store — start each test from a known, disarmed state.
  S().reset();
  S().setRules(DEFAULT_RULES);
  S().setLimits(DEFAULT_LIMITS);
  S().setDryRun(true);
});

describe('arm / disarm lifecycle', () => {
  it('arms into a fresh run and logs it', () => {
    S().arm(1_000);
    expect(S().status).toBe('armed');
    expect(S().run.armedAt).toBe(1_000);
    expect(S().run.tradeCount).toBe(0);
    expect(S().log[0].kind).toBe('armed');
  });

  it('a manual disarm has no stop reason; an auto disarm carries one', () => {
    S().arm(1_000);
    S().disarm('manual', 2_000);
    expect(S().status).toBe('stopped');
    expect(S().stopReason).toBeNull();
    expect(S().log[0].kind).toBe('disarmed');

    S().arm(3_000);
    S().disarm('budget_spent', 4_000);
    expect(S().stopReason).toBe('budget_spent');
  });
});

describe('recordPlacement + buildRuntime', () => {
  it('bumps spend/count, stamps the market, and reflects in the runtime snapshot', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xa', sizeUsd: 5, expiry: 10_000 }), { dryRun: true }, 1_100);
    S().recordPlacement(trade({ marketId: '0xb', sizeUsd: 5, expiry: 10_000 }), { dryRun: true }, 1_200);

    const rt = S().buildRuntime(1_300);
    expect(rt.spentUsd).toBe(10);
    expect(rt.tradeCount).toBe(2);
    expect(rt.openCount).toBe(2);
    expect(rt.lastTradeAt).toBe(1_200);
    expect(rt.firedMarkets['0xa']).toBe(1_100);
    // placement log lines carry the dry-run flag
    expect(S().log[0].kind).toBe('placed');
    expect(S().log[0].dryRun).toBe(true);
  });

  it('openCount in the runtime excludes positions whose expiry has passed', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xshort', expiry: 2_000 }), { dryRun: true }, 1_100);
    S().recordPlacement(trade({ marketId: '0xlong', expiry: 9_000 }), { dryRun: true }, 1_100);
    // one has expired by t=3000
    expect(S().buildRuntime(3_000).openCount).toBe(1);
  });
});

describe('pruneExpired', () => {
  it('drops expired positions and leaves live ones (streak untouched)', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xshort', expiry: 2_000 }), { dryRun: true }, 1_100);
    S().recordPlacement(trade({ marketId: '0xlong', expiry: 9_000 }), { dryRun: true }, 1_100);
    const pruned = S().pruneExpired(3_000);
    expect(pruned).toBe(1);
    expect(S().run.open.map((p) => p.marketId)).toEqual(['0xlong']);
    expect(S().run.consecutiveLosses).toBe(0);
  });
});

describe('recordSettlement', () => {
  it('frees the slot and grows the losing streak on a loss, resets it on a win', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xa', expiry: 9_000 }), { dryRun: false }, 1_100);
    S().recordSettlement('0xa', false, 2_000);
    expect(S().run.consecutiveLosses).toBe(1);
    expect(S().run.open).toHaveLength(0);

    S().recordPlacement(trade({ marketId: '0xb', expiry: 9_000 }), { dryRun: false }, 2_100);
    S().recordSettlement('0xb', true, 3_000);
    expect(S().run.consecutiveLosses).toBe(0);
  });
});

describe('log cap', () => {
  it('keeps the newest entries first and never grows past the cap', () => {
    S().arm(1_000);
    for (let i = 0; i < 200; i++) S().noteHold(`hold ${i}`, '0xm', 1_000 + i);
    expect(S().log.length).toBeLessThanOrEqual(120);
    // newest first
    expect(S().log[0].text).toBe('hold 199');
  });
});
