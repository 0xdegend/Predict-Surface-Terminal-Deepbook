import { describe, it, expect } from 'vitest';
import { buildSessionReportInput } from './report-client';
import type { RunResult, AutopilotLogEntry } from '@/lib/store/autopilot-store';
import type { AutopilotRules, AutopilotLimits } from '@/lib/autopilot/policy';

const rules: AutopilotRules = { minEdge: 0, minProb: 0.6, maxLeverage: 2, tenors: ['hour'], sides: ['up', 'down'] };
const limits: AutopilotLimits = {
  budgetUsd: 25, perTradeUsd: 5, armDurationMs: 3_600_000, maxTrades: 10, maxConcurrent: 2, cooldownMs: 60_000, maxConsecutiveLosses: 3,
};

const run: RunResult = {
  id: 'r1', armedAt: 1000, endedAt: 5000, dryRun: false, stopReason: 'manual',
  budgetUsd: 25, perTradeUsd: 5, tradeCount: 2, wins: 1, losses: 1, pendingCount: 0, realizedPnlUsd: 3.5,
  trades: [
    { marketId: '0xm1', side: 'up', strike: 60_000, stake: 5, entryProb: 0.62, outcome: 'won', pnlUsd: 4, at: 1500, digest: '0xabc' },
    { marketId: '0xm2', side: 'down', strike: 61_000, stake: 5, entryProb: 0.58, outcome: 'lost', pnlUsd: -5, at: 2500, digest: null },
  ],
};

const log: AutopilotLogEntry[] = [
  { id: 'l3', at: 6000, kind: 'armed', text: 'next run' }, // after window → excluded
  { id: 'l2', at: 2500, kind: 'placed', text: 'Placed $5 DOWN', digest: null, marketId: '0xm2' },
  { id: 'l1', at: 1500, kind: 'placed', text: 'Placed $5 UP', digest: '0xabc', marketId: '0xm1' },
  { id: 'l0', at: 500, kind: 'armed', text: 'earlier run' }, // before window → excluded
];

describe('buildSessionReportInput', () => {
  it('maps the run + config, marks live mode, and carries each trade digest', () => {
    const input = buildSessionReportInput({ run, rules, limits, log });
    expect(input.run.mode).toBe('live');
    expect(input.run).toMatchObject({ id: 'r1', realizedPnlUsd: 3.5, wins: 1, losses: 1 });
    expect(input.config).toMatchObject({ minProb: 0.6, maxTrades: 10, tenors: ['hour'], sides: ['up', 'down'], armDurationMs: 3_600_000 });
    expect(input.trades).toHaveLength(2);
    expect(input.trades[0]).toMatchObject({ marketId: '0xm1', side: 'up', digest: '0xabc', outcome: 'won' });
    expect(input.trades[1].digest).toBeNull();
  });

  it('windows the decision log to the run and orders it oldest-first', () => {
    const input = buildSessionReportInput({ run, rules, limits, log });
    // The 500 (before arm) and 6000 (after end) lines are excluded; the rest sorted ascending.
    expect(input.decisions.map((d) => d.at)).toEqual([1500, 2500]);
    expect(input.decisions[0]).toMatchObject({ kind: 'placed', marketId: '0xm1', digest: '0xabc' });
  });

  it('marks a watch-mode (simulated) run', () => {
    const input = buildSessionReportInput({ run: { ...run, dryRun: true }, rules, limits, log });
    expect(input.run.mode).toBe('watch');
  });
});
