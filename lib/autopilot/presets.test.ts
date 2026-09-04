import { describe, it, expect } from 'vitest';
import { PRESETS, presetPatch, matchPreset, planSentence, DEFAULT_PRESET } from './presets';
import type { AutopilotRules, AutopilotLimits } from './policy';

// Mirrors the store's DEFAULT_RULES / DEFAULT_LIMITS (= the Balanced preset). Kept local
// so this pure-module test doesn't pull in the Zustand store.
const DEFAULT_RULES: AutopilotRules = {
  minProb: 0.6,
  minEdge: 0,
  tenors: ['soonest', 'hour'],
  sides: ['up', 'down', 'range'],
  maxLeverage: 2,
};
const DEFAULT_LIMITS: AutopilotLimits = {
  budgetUsd: 25,
  perTradeUsd: 5,
  maxTrades: 5,
  maxConcurrent: 3,
  cooldownMs: 90_000,
  armDurationMs: 60 * 60_000,
  maxConsecutiveLosses: 3,
};

describe('presets', () => {
  it('has three distinct styles with a rising risk gradient', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['cautious', 'balanced', 'bold']);
    expect(PRESETS.map((p) => p.risk)).toEqual([1, 2, 3]);
  });

  it('the default rules + limits match the default (Balanced) preset', () => {
    expect(matchPreset(DEFAULT_RULES, DEFAULT_LIMITS)).toBe(DEFAULT_PRESET);
  });

  it('every preset round-trips: apply its patch, then it matches', () => {
    for (const p of PRESETS) {
      const patch = presetPatch(p.id);
      const rules: AutopilotRules = { ...DEFAULT_RULES, ...patch.rules };
      const limits: AutopilotLimits = { ...DEFAULT_LIMITS, ...patch.limits };
      expect(matchPreset(rules, limits)).toBe(p.id);
    }
  });

  it('never touches budget / per-trade / run length', () => {
    const patch = presetPatch('bold');
    expect(patch.limits).not.toHaveProperty('budgetUsd');
    expect(patch.limits).not.toHaveProperty('perTradeUsd');
    expect(patch.limits).not.toHaveProperty('armDurationMs');
    // Applying a preset over custom money keeps that money intact.
    const custom: AutopilotLimits = { ...DEFAULT_LIMITS, budgetUsd: 500, perTradeUsd: 50, armDurationMs: 30 * 60_000 };
    const merged = { ...custom, ...patch.limits };
    expect(merged.budgetUsd).toBe(500);
    expect(merged.perTradeUsd).toBe(50);
    expect(merged.armDurationMs).toBe(30 * 60_000);
  });

  it('reports Custom (null) once a preset-controlled field is changed', () => {
    const rules: AutopilotRules = { ...DEFAULT_RULES, minProb: 0.62 };
    expect(matchPreset(rules, DEFAULT_LIMITS)).toBeNull();
  });

  it('a money-only change stays on its preset', () => {
    const patch = presetPatch('balanced');
    const rules = { ...DEFAULT_RULES, ...patch.rules };
    const limits = { ...DEFAULT_LIMITS, ...patch.limits, budgetUsd: 999, perTradeUsd: 42 };
    expect(matchPreset(rules, limits)).toBe('balanced');
  });
});

describe('range bets', () => {
  it('every preset offers UP, DOWN and a range', () => {
    for (const p of PRESETS) expect(p.shape.sides).toEqual(['up', 'down', 'range']);
  });

  it('the plan sentence lists all three shapes', () => {
    const s = planSentence({ ...DEFAULT_RULES, sides: ['up', 'down', 'range'] }, DEFAULT_LIMITS);
    expect(s).toContain('UP, DOWN or range');
  });

  it('and reads a single shape plainly', () => {
    expect(planSentence({ ...DEFAULT_RULES, sides: ['range'] }, DEFAULT_LIMITS)).toContain('range bets');
    expect(planSentence({ ...DEFAULT_RULES, sides: [] }, DEFAULT_LIMITS)).toContain('no bets');
  });
});

describe('planSentence', () => {
  it('states the count, style, direction, money, time, and loss cap in plain words', () => {
    const s = planSentence(
      { ...DEFAULT_RULES, minProb: 0.7, maxLeverage: 1, sides: ['up', 'down'] },
      { ...DEFAULT_LIMITS, maxTrades: 3, perTradeUsd: 5, armDurationMs: 15 * 60_000, maxConsecutiveLosses: 2 },
    );
    expect(s).toContain('Up to 3');
    expect(s).toContain('careful');
    expect(s).toContain('UP or DOWN');
    expect(s).toContain('$5 each');
    expect(s).toContain('15 minutes');
    expect(s).toContain('Stops after 2 losses in a row');
    expect(s).not.toContain('—'); // plain punctuation only
  });

  it('mentions leverage only when above 1x, and speaks hours', () => {
    const withLev = planSentence(
      { ...DEFAULT_RULES, maxLeverage: 3 },
      { ...DEFAULT_LIMITS, armDurationMs: 60 * 60_000 },
    );
    expect(withLev).toContain('up to 3x');
    // "over the next 1 hour" is not how anyone says it, and it was on the arm confirm.
    expect(withLev).toContain('over the next hour');
    expect(withLev).not.toContain('next 1 hour');
    // A count only disappears when it is exactly one.
    expect(planSentence(DEFAULT_RULES, { ...DEFAULT_LIMITS, armDurationMs: 120 * 60_000 })).toContain(
      'over the next 2 hours',
    );
    expect(planSentence(DEFAULT_RULES, { ...DEFAULT_LIMITS, armDurationMs: 90 * 60_000 })).toContain(
      'over the next 1.5 hours',
    );

    const noLev = planSentence({ ...DEFAULT_RULES, maxLeverage: 1 }, DEFAULT_LIMITS);
    expect(noLev).not.toContain('x.');
    expect(noLev).not.toContain('up to 1x');
  });

  it('handles a single trade and a single-loss cap without plural s', () => {
    const s = planSentence(DEFAULT_RULES, { ...DEFAULT_LIMITS, maxTrades: 1, maxConsecutiveLosses: 1 });
    expect(s).toContain('Up to 1 ');
    expect(s).toContain('bet,');
    expect(s).toContain('1 loss in a row');
  });
});
