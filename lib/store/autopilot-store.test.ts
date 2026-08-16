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
  S().clearHistory();
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
  it('drops expired simulated positions and leaves live ones (streak untouched)', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xshort', expiry: 2_000 }), { dryRun: true }, 1_100);
    S().recordPlacement(trade({ marketId: '0xlong', expiry: 9_000 }), { dryRun: true }, 1_100);
    const pruned = S().pruneExpired(3_000);
    expect(pruned).toBe(1);
    expect(S().run.open.map((p) => p.marketId)).toEqual(['0xlong']);
    expect(S().run.consecutiveLosses).toBe(0);
  });

  it('keeps a REAL position past expiry for settlement, then drops it after the grace', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xreal', expiry: 2_000 }), { dryRun: false }, 1_100);
    // Just past expiry, within grace: kept so the engine can read its settlement.
    expect(S().pruneExpired(2_500, 5_000)).toBe(0);
    expect(S().run.open.map((p) => p.marketId)).toEqual(['0xreal']);
    // Past expiry + grace with no settlement: retired unscored (streak untouched).
    expect(S().pruneExpired(8_000, 5_000)).toBe(1);
    expect(S().run.open).toHaveLength(0);
    expect(S().run.consecutiveLosses).toBe(0);
  });
});

describe('recordPlacement stores scoring detail', () => {
  it('carries side + strike (binary) and the dry-run flag onto the open position', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xb', side: 'down', strike: 60_000 }), { dryRun: false }, 1_100);
    const pos = S().run.open[0];
    expect(pos.side).toBe('down');
    expect(pos.strike).toBe(60_000);
    expect(pos.dryRun).toBe(false);
  });
});

describe('recordSettlement realizes the PnL tape', () => {
  it('a win pays notional minus cost; a loss is -cost; both feed the running total', () => {
    S().arm(1_000);
    // Unleveraged qty $10, cost $5 → a win realizes +$5.
    S().recordPlacement(trade({ marketId: '0xw', qty: 10, cost: 5, entryProb: 0.5, leverage: 1 }), { dryRun: false }, 1_100);
    S().recordSettlement('0xw', true, 2_000);
    expect(S().run.realizedPnlUsd).toBeCloseTo(5);
    expect(S().run.wins).toBe(1);
    expect(S().run.losses).toBe(0);

    // A $5-cost loss takes it back to 0.
    S().recordPlacement(trade({ marketId: '0xl', qty: 10, cost: 5, entryProb: 0.5, leverage: 1 }), { dryRun: false }, 2_100);
    S().recordSettlement('0xl', false, 3_000);
    expect(S().run.realizedPnlUsd).toBeCloseTo(0);
    expect(S().run.losses).toBe(1);
  });

  it('a leveraged win nets out the static floor', () => {
    S().arm(1_000);
    // qty $10, entry 60%, 2x → floor = 0.6·10·(1−1/2) = $3 → payout $7 → minus $5 cost = +$2.
    S().recordPlacement(trade({ marketId: '0xlev', qty: 10, cost: 5, entryProb: 0.6, leverage: 2 }), { dryRun: false }, 1_100);
    S().recordSettlement('0xlev', true, 2_000);
    expect(S().run.realizedPnlUsd).toBeCloseTo(2);
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

describe('results archive', () => {
  it('saves a run to history when it stops (with a stop reason + trades), not a no-trade run', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xa', qty: 10, cost: 5 }), { dryRun: false }, 1_100);
    S().recordSettlement('0xa', true, 2_000); // settles while armed → no history yet
    expect(S().history).toHaveLength(0);
    S().disarm('duration_elapsed', 3_000);
    expect(S().history).toHaveLength(1);
    const r = S().history[0];
    expect(r.tradeCount).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.realizedPnlUsd).toBeCloseTo(5);
    expect(r.stopReason).toBe('duration_elapsed');
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].outcome).toBe('won');
  });

  it('does not save a run that placed no trades', () => {
    S().arm(1_000);
    S().disarm('manual', 2_000);
    expect(S().history).toHaveLength(0);
  });

  it('completes a saved run IN PLACE as its late trades settle after the stop', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xopen', qty: 10, cost: 5, expiry: 9_000 }), { dryRun: false }, 1_100);
    S().disarm('duration_elapsed', 2_000); // position still open → saved as pending
    expect(S().history).toHaveLength(1);
    const id = S().history[0].id;
    expect(S().history[0].pendingCount).toBe(1);
    expect(S().history[0].trades[0].outcome).toBe('pending');

    S().recordSettlement('0xopen', true, 3_000); // settles post-stop
    expect(S().history).toHaveLength(1); // same entry, not a new one
    expect(S().history[0].id).toBe(id);
    expect(S().history[0].wins).toBe(1);
    expect(S().history[0].pendingCount).toBe(0);
    expect(S().history[0].trades[0].outcome).toBe('won');
    expect(S().history[0].endedAt).toBe(2_000); // fixed at stop, not at settle time
  });

  it('records a grace-pruned position as a pending result rather than losing it', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xstale', qty: 10, cost: 5, expiry: 2_000 }), { dryRun: false }, 1_100);
    S().disarm('manual', 2_500);
    // Past expiry + grace with no settlement → dropped, but kept as a pending result.
    S().pruneExpired(10_000, 5_000);
    expect(S().history[0].trades[0].outcome).toBe('pending');
    expect(S().history[0].pendingCount).toBe(1);
  });

  it('a reload never resumes an armed run: it lands stopped, flagged, and saved', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xa', qty: 10, cost: 5, expiry: 9_000 }), { dryRun: false }, 1_100);
    expect(S().status).toBe('armed');
    // Simulate what onRehydrateStorage does after a reload loads the persisted run.
    S()._resumeAfterReload();
    expect(S().status).toBe('stopped'); // never armed after a reload
    expect(S().interruptedByReload).toBe(true);
    // The open trade is still tracked so it can settle + show.
    expect(S().run.open).toHaveLength(1);
    // The interrupted run is saved to results like any finished run.
    expect(S().history).toHaveLength(1);
    expect(S().history[0].pendingCount).toBe(1);
    // Arming again clears the reload flag.
    S().arm(2_000);
    expect(S().interruptedByReload).toBe(false);
  });

  it('reload is a no-op for a run that was not armed', () => {
    S().arm(1_000);
    S().disarm('manual', 2_000);
    S()._resumeAfterReload();
    expect(S().status).toBe('stopped');
    expect(S().interruptedByReload).toBe(false);
  });

  it('deletes one result and clears them all', () => {
    S().arm(1_000);
    S().recordPlacement(trade({ marketId: '0xa', qty: 10, cost: 5 }), { dryRun: false }, 1_100);
    S().disarm('manual', 2_000);
    const id = S().history[0].id;
    S().deleteResult(id);
    expect(S().history).toHaveLength(0);

    S().arm(3_000);
    S().recordPlacement(trade({ marketId: '0xb', qty: 10, cost: 5 }), { dryRun: false }, 3_100);
    S().disarm('manual', 4_000);
    expect(S().history).toHaveLength(1);
    S().clearHistory();
    expect(S().history).toHaveLength(0);
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
