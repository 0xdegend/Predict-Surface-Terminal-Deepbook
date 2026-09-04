import { describe, it, expect } from 'vitest';
import { planPhases } from './plan-phases';
import type { AutopilotLimits, AutopilotRules } from './policy';

const RULES: AutopilotRules = {
  minProb: 0.68,
  minEdge: 0,
  tenors: ['soonest', 'hour'],
  sides: ['up', 'down'],
  maxLeverage: 1,
};

const LIMITS: AutopilotLimits = {
  budgetUsd: 100,
  perTradeUsd: 33,
  maxTrades: 3,
  maxConcurrent: 2,
  cooldownMs: 90_000,
  armDurationMs: 15 * 60_000,
  maxConsecutiveLosses: 2,
};

const detail = (id: string, r = RULES, l = LIMITS) => planPhases(r, l).find((p) => p.id === id)!.detail;

describe('planPhases', () => {
  it('is the four steps of the loop, in order', () => {
    expect(planPhases(RULES, LIMITS).map((p) => p.id)).toEqual(['watch', 'pick', 'stake', 'stop']);
  });

  it('says every number out loud', () => {
    const all = planPhases(RULES, LIMITS)
      .map((p) => `${p.title} ${p.detail}`)
      .join(' ');
    expect(all).toContain('68%'); // the win-chance floor
    expect(all).toContain('$33'); // per bet
    expect(all).toContain('3 bets'); // the cap
    expect(all).toContain('15 minutes'); // the run length
    expect(all).toContain('2 losses'); // the stop
    expect(all).toContain('$100'); // the budget
  });

  it('never leaves an em dash in trader-facing copy', () => {
    for (const p of planPhases(RULES, LIMITS)) {
      expect(p.title).not.toMatch(/[—–]/);
      expect(p.detail).not.toMatch(/[—–]/);
    }
  });

  it('names a setting that would stop the run dead, instead of reading as normal', () => {
    // Empty windows or empty sides mean NOTHING can ever fire. That is the single most
    // useful thing this card can tell someone about to arm, so it must not be phrased
    // as an ordinary sentence with a blank in it.
    expect(detail('watch', { ...RULES, tenors: [] })).toMatch(/no windows picked/i);
    expect(detail('pick', { ...RULES, sides: [] })).toMatch(/no direction picked/i);
    expect(detail('pick', { ...RULES, sides: ['up', 'down', 'range'] })).toContain('going UP, DOWN or range');
  });

  it('lists the windows a trader actually picked', () => {
    expect(detail('watch', { ...RULES, tenors: ['soonest'] })).toContain('the next few minutes');
    expect(detail('watch', { ...RULES, tenors: ['soonest', 'hour', 'today'] })).toMatch(
      /the next few minutes, about an hour or later today/,
    );
  });

  it('mentions leverage only when there is some', () => {
    expect(detail('pick')).not.toMatch(/x\b/);
    expect(detail('pick', { ...RULES, maxLeverage: 2 })).toContain('up to 2x');
  });

  it('gets singulars right', () => {
    const one = planPhases(RULES, { ...LIMITS, maxTrades: 1, maxConsecutiveLosses: 1 });
    expect(one.find((p) => p.id === 'stake')!.detail).toContain('1 bet,');
    expect(one.find((p) => p.id === 'stop')!.detail).toContain('1 loss in a row');
    // The Bold preset's cooldown is exactly one minute, so this one was on screen:
    // "Up to 8 bets, 4 open at a time, 1 minutes between them."
    expect(detail('stake', RULES, { ...LIMITS, cooldownMs: 60_000 })).toContain('1 minute between');
    expect(detail('stake', RULES, { ...LIMITS, cooldownMs: 1_000 })).toContain('1 second between');
    expect(detail('stake', RULES, { ...LIMITS, cooldownMs: 120_000 })).toContain('2 minutes between');
  });

  it('writes an hour as an hour and a cent amount in full', () => {
    expect(detail('stop', RULES, { ...LIMITS, armDurationMs: 60 * 60_000 })).toContain('1 hour');
    expect(detail('stop', RULES, { ...LIMITS, armDurationMs: 90 * 60_000 })).toContain('1.5 hours');
    expect(planPhases(RULES, { ...LIMITS, perTradeUsd: 2.5 })[2].title).toBe('Stakes $2.50');
  });
});
