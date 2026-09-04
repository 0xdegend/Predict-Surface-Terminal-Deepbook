import { describe, it, expect } from 'vitest';
import { PRESETS, presetPatch, matchPreset, planSentence, DEFAULT_PRESET, paceFor, perBetFor, isAutoSized, legacyPresetOf, LEGACY_PACE } from './presets';
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
// $25 over an hour on Balanced paces to 5 bets (the $5 floor caps the count), spread
// to the ten-minute ceiling.
const DEFAULT_LIMITS: AutopilotLimits = {
  budgetUsd: 25,
  perTradeUsd: 5,
  maxTrades: 5,
  maxConcurrent: 3,
  cooldownMs: 600_000,
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
      const patch = presetPatch(p.id, DEFAULT_LIMITS);
      const rules: AutopilotRules = { ...DEFAULT_RULES, ...patch.rules };
      const limits: AutopilotLimits = { ...DEFAULT_LIMITS, ...patch.limits };
      expect(matchPreset(rules, limits)).toBe(p.id);
    }
  });

  it('never touches budget / per-trade / run length', () => {
    const patch = presetPatch('bold', DEFAULT_LIMITS);
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

  it('a money or time change, re-paced as the panel does it, stays on its preset', () => {
    const run = { armDurationMs: 15 * 60_000, budgetUsd: 999 };
    const patch = presetPatch('balanced', run);
    const rules = { ...DEFAULT_RULES, ...patch.rules };
    const limits = { ...DEFAULT_LIMITS, ...patch.limits, ...run, perTradeUsd: 42 };
    expect(matchPreset(rules, limits)).toBe('balanced');
  });

  it('a hand-set bet count or gap reads Custom', () => {
    expect(matchPreset(DEFAULT_RULES, { ...DEFAULT_LIMITS, maxTrades: 7 })).toBeNull();
    expect(matchPreset(DEFAULT_RULES, { ...DEFAULT_LIMITS, cooldownMs: 30_000 })).toBeNull();
  });
});

describe('paceFor: the bet count and gap follow the run length', () => {
  const MIN = 60_000;

  it('a $500 careful 15-minute run is five bets three minutes apart (it used to be three bets, done in four minutes)', () => {
    expect(paceFor('cautious', { armDurationMs: 15 * MIN, budgetUsd: 500 })).toEqual({ maxTrades: 5, cooldownMs: 180_000 });
    expect(perBetFor(500, 5)).toBe(100);
  });

  it('a shorter run makes fewer bets, a longer one more, inside the style bounds', () => {
    expect(paceFor('cautious', { armDurationMs: 5 * MIN, budgetUsd: 8000 })).toEqual({ maxTrades: 2, cooldownMs: 150_000 });
    expect(paceFor('cautious', { armDurationMs: 30 * MIN, budgetUsd: 5000 }).maxTrades).toBe(10);
    expect(paceFor('cautious', { armDurationMs: 6 * 60 * MIN, budgetUsd: 5000 }).maxTrades).toBe(12); // the careful ceiling
    expect(paceFor('bold', { armDurationMs: 5 * MIN, budgetUsd: 500 })).toEqual({ maxTrades: 4, cooldownMs: 75_000 }); // the bold floor
  });

  it('bolder styles bet more often than careful ones over the same run', () => {
    const run = { armDurationMs: 15 * MIN, budgetUsd: 1000 };
    const [c, b, x] = (['cautious', 'balanced', 'bold'] as const).map((id) => paceFor(id, run).maxTrades);
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(x);
  });

  it('never plans a bet under $5: the budget brings the count down, not the bet', () => {
    expect(paceFor('balanced', { armDurationMs: 60 * MIN, budgetUsd: 25 }).maxTrades).toBe(5);
    expect(paceFor('bold', { armDurationMs: 60 * MIN, budgetUsd: 3 }).maxTrades).toBe(1);
  });

  it('spreads the bets over the run, between the style floor and ten minutes', () => {
    expect(paceFor('balanced', { armDurationMs: 60 * MIN, budgetUsd: 25 }).cooldownMs).toBe(600_000); // 5 bets over an hour, capped
    expect(paceFor('bold', { armDurationMs: 2 * MIN, budgetUsd: 500 }).cooldownMs).toBe(45_000); // never under the floor
    expect(paceFor('balanced', { armDurationMs: 15 * MIN, budgetUsd: 1000 }).cooldownMs).toBe(105_000); // 8 bets, to the 15s below
  });

  it('isAutoSized tells a split budget from a typed bet size', () => {
    expect(isAutoSized({ budgetUsd: 500, perTradeUsd: 166.67, maxTrades: 3 })).toBe(true);
    expect(isAutoSized({ budgetUsd: 500, perTradeUsd: 50, maxTrades: 3 })).toBe(false);
  });

  it('legacyPresetOf recognises a pre-pacing saved config by its old fixed numbers', () => {
    const rules = { ...DEFAULT_RULES, ...presetPatch('cautious', DEFAULT_LIMITS).rules };
    const limits = { ...DEFAULT_LIMITS, maxConcurrent: 2, maxConsecutiveLosses: 2, ...LEGACY_PACE.cautious };
    expect(legacyPresetOf(rules, limits)).toBe('cautious');
    expect(legacyPresetOf(rules, { ...limits, maxTrades: 4 })).toBeNull();
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
