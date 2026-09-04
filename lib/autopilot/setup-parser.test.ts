import { describe, it, expect } from 'vitest';
import { parseSetup, resolveSetup, missingFrom, isComplete, mergeIntents, emptyIntent, sanitizeIntent, wantsStart } from './setup-parser';

// The panel's current money/time, used as the fallback when a phrase leaves a gap.
const CURRENT = { budgetUsd: 25, perTradeUsd: 5, armDurationMs: 60 * 60_000 };

describe('parseSetup — style', () => {
  it('reads safe / cautious words as the Cautious preset', () => {
    expect(parseSetup('keep it safe').preset).toBe('cautious');
    expect(parseSetup('be careful please').preset).toBe('cautious');
    expect(parseSetup('play it safe with $25').preset).toBe('cautious');
  });

  it('reads bold / aggressive words as the Bold preset', () => {
    expect(parseSetup('go bold').preset).toBe('bold');
    expect(parseSetup('be aggressive').preset).toBe('bold');
    expect(parseSetup('yolo it').preset).toBe('bold');
  });

  it('reads balanced / steady words as the Balanced preset', () => {
    expect(parseSetup('keep it balanced').preset).toBe('balanced');
    expect(parseSetup('something steady').preset).toBe('balanced');
  });

  it('falls back to Balanced (not named) when no style word is present', () => {
    const i = parseSetup('$50 for an hour');
    expect(i.preset).toBe('balanced');
    expect(i.presetNamed).toBe(false);
  });
});

describe('parseSetup — money', () => {
  it('reads a $-prefixed budget', () => {
    expect(parseSetup('cautious, $25 for an hour').budgetUsd).toBe(25);
  });

  it('reads a keyword-led budget with no dollar sign', () => {
    expect(parseSetup('risk about 20 for an hour').budgetUsd).toBe(20);
  });

  it('separates a per-bet size from the budget', () => {
    const i = parseSetup('$5 a bet, $30 total');
    expect(i.perTradeUsd).toBe(5);
    expect(i.budgetUsd).toBe(30);
  });

  it('does not read a duration number as a budget', () => {
    const i = parseSetup('balanced for 30 minutes');
    expect(i.durationMins).toBe(30);
    expect(i.budgetUsd).toBeUndefined();
  });

  it('ignores leverage and percentage numbers', () => {
    const i = parseSetup('bold, 2x, only 70% likely');
    expect(i.budgetUsd).toBeUndefined();
    expect(i.perTradeUsd).toBeUndefined();
  });
});

describe('parseSetup — duration', () => {
  it('reads "an hour" as 60 minutes', () => {
    expect(parseSetup('safe for an hour').durationMins).toBe(60);
  });
  it('reads "2 hours" as 120 minutes', () => {
    expect(parseSetup('go bold with $100 for 2 hours').durationMins).toBe(120);
  });
  it('reads "half an hour" as 30 minutes', () => {
    expect(parseSetup('balanced for half an hour').durationMins).toBe(30);
  });
  it('reads "15m" as 15 minutes', () => {
    expect(parseSetup('watch mode 15m').durationMins).toBe(15);
  });
  it('leaves duration undefined when none is named', () => {
    expect(parseSetup('go bold with $100').durationMins).toBeUndefined();
  });
});

describe('parseSetup — mode', () => {
  it('reads watch / practice words as watch mode', () => {
    expect(parseSetup('watch mode first, $25').live).toBe(false);
    expect(parseSetup('just practice for now').live).toBe(false);
  });
  it('reads live / real words as live', () => {
    expect(parseSetup('trade for real, $50').live).toBe(true);
    expect(parseSetup('go live with $25').live).toBe(true);
  });
  it('leaves mode undefined when unspecified', () => {
    expect(parseSetup('balanced, $50').live).toBeUndefined();
  });
});

describe('resolveSetup', () => {
  it('fills gaps from the current money/time and keeps mode absent', () => {
    const r = resolveSetup(parseSetup('go bold'), CURRENT);
    expect(r.preset).toBe('bold');
    expect(r.budgetUsd).toBe(25); // kept from current
    expect(r.perTradeUsd).toBe(5); // kept from current
    expect(r.durationMins).toBe(60); // kept from current
    expect(r.live).toBeUndefined();
  });

  it('sizes the per-bet from the budget over the bets the style paces into the run', () => {
    // $50 over the current hour on Balanced: the $5 floor caps it at 10 bets of $5.
    const r = resolveSetup(parseSetup('balanced $50'), CURRENT);
    expect(r.budgetUsd).toBe(50);
    expect(r.perTradeUsd).toBe(5);
  });

  it('a 15-minute careful run with $500 is five bets of $100, not three of $167', () => {
    const r = resolveSetup(parseSetup('careful, $500 for 15 minutes'), CURRENT);
    expect(r.preset).toBe('cautious');
    expect(r.durationMins).toBe(15);
    expect(r.perTradeUsd).toBe(100);
  });

  it('a shorter run gets fewer, bigger bets', () => {
    const r = resolveSetup(parseSetup('careful, $8000 for 5 minutes'), CURRENT);
    expect(r.perTradeUsd).toBe(4000);
  });

  it('splits the budget to the cent over the paced count so every planned trade fits', () => {
    // $5,000 careful over 30 minutes paces to 10 bets. Whole-dollar rounding once left
    // $2 of a budget never placed, and the trade cap ended the run there.
    const r = resolveSetup(parseSetup('careful, $5000 for 30 minutes'), CURRENT);
    expect(r.budgetUsd).toBe(5000);
    expect(r.perTradeUsd).toBe(500);
    expect(Math.abs(r.perTradeUsd * 10 - r.budgetUsd)).toBeLessThan(0.05);
    // And a split that does not come out even is carried to the cent.
    expect(resolveSetup(parseSetup('careful, $1000 for 15 minutes'), CURRENT).perTradeUsd).toBe(200);
    expect(resolveSetup(parseSetup('careful, $1234 for 15 minutes'), CURRENT).perTradeUsd).toBe(246.8);
  });

  it('never lets the per-bet exceed the budget', () => {
    const r = resolveSetup(parseSetup('$5 a bet, $3 total'), CURRENT);
    expect(r.budgetUsd).toBe(3);
    expect(r.perTradeUsd).toBe(3);
  });

  it('carries an explicit mode through', () => {
    expect(resolveSetup(parseSetup('go live, $40'), CURRENT).live).toBe(true);
    expect(resolveSetup(parseSetup('watch first, $40'), CURRENT).live).toBe(false);
  });
});

/* --------------------- gaps, merging, and sanitizing ---------------------- */

describe('missingFrom', () => {
  it('reports every required piece when the trader said nothing useful', () => {
    expect(missingFrom(emptyIntent())).toEqual(['style', 'budget', 'duration']);
  });

  it('reports nothing once style, budget and duration are all named', () => {
    const i = parseSetup('cautious, $25 for an hour');
    expect(missingFrom(i)).toEqual([]);
    expect(isComplete(i)).toBe(true);
  });

  it('does NOT treat a defaulted style as named', () => {
    // parseSetup falls back to 'balanced' with presetNamed false. That default must
    // read as a gap, otherwise Kelly silently picks a risk profile for the trader.
    const i = parseSetup('$50 for 30 minutes');
    expect(i.preset).toBe('balanced');
    expect(i.presetNamed).toBe(false);
    expect(missingFrom(i)).toEqual(['style']);
  });

  it('asks for the budget when only a style was given', () => {
    expect(missingFrom(parseSetup('go bold'))).toEqual(['budget', 'duration']);
  });

  it('never asks about watch vs live, which the arm confirm owns', () => {
    const i = parseSetup('cautious $25 for an hour in watch mode');
    expect(i.live).toBe(false);
    expect(missingFrom(i)).toEqual([]);
  });
});

describe('mergeIntents', () => {
  it('builds a setup across separate replies', () => {
    let i = emptyIntent();
    i = mergeIntents(i, parseSetup('cautious'));
    expect(missingFrom(i)).toEqual(['budget', 'duration']);
    i = mergeIntents(i, parseSetup('$50'));
    expect(missingFrom(i)).toEqual(['duration']);
    i = mergeIntents(i, parseSetup('for an hour'));
    expect(missingFrom(i)).toEqual([]);
    expect(i).toMatchObject({ preset: 'cautious', budgetUsd: 50, durationMins: 60 });
  });

  it('lets a later turn correct an earlier one', () => {
    const first = parseSetup('bold, $100 for 2 hours');
    const corrected = mergeIntents(first, parseSetup('actually make it $20'));
    expect(corrected.budgetUsd).toBe(20);
    expect(corrected.preset).toBe('bold'); // untouched by the correction
    expect(corrected.durationMins).toBe(120);
  });

  it('keeps an earlier style when the later turn names none', () => {
    const merged = mergeIntents(parseSetup('cautious'), parseSetup('$30'));
    expect(merged.preset).toBe('cautious');
    expect(merged.presetNamed).toBe(true);
  });
});

describe('sanitizeIntent', () => {
  it('accepts a well-formed model payload', () => {
    const i = sanitizeIntent({ style: 'bold', budgetUsd: 100, durationMins: 60, live: true });
    expect(i).toMatchObject({ preset: 'bold', presetNamed: true, budgetUsd: 100, durationMins: 60, live: true });
  });

  it('DROPS out-of-range numbers rather than clamping them', () => {
    // A dropped field becomes a question; a clamped one becomes a silent assumption.
    const i = sanitizeIntent({ style: 'cautious', budgetUsd: 5_000_000, durationMins: 0 });
    expect(i.budgetUsd).toBeUndefined();
    expect(i.durationMins).toBeUndefined();
    expect(missingFrom(i)).toEqual(['budget', 'duration']);
  });

  it('rejects a style the model invented', () => {
    const i = sanitizeIntent({ style: 'yolo-max', budgetUsd: 25 });
    expect(i.presetNamed).toBe(false);
    expect(i.preset).toBe('balanced');
  });

  it('survives junk, nulls and wrong types without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { budgetUsd: '25', durationMins: NaN, live: 'yes' }]) {
      const i = sanitizeIntent(junk);
      expect(i.presetNamed).toBe(false);
      expect(i.budgetUsd).toBeUndefined();
      expect(i.live).toBeUndefined();
    }
  });

  it('never lets the model imply an amount the trader did not give', () => {
    const i = sanitizeIntent({ style: 'balanced' });
    expect(i.budgetUsd).toBeUndefined();
    expect(missingFrom(i)).toContain('budget');
  });
});

describe('wantsStart', () => {
  it('reads a plain go-ahead as the start command', () => {
    for (const m of ['start', 'Start', 'start trading', 'start it', 'go', 'go ahead', 'begin', 'run it', "let's go", 'do it', 'fire it up']) {
      expect(wantsStart(m)).toBe(true);
    }
  });

  it('tolerates agreement in front and politeness behind', () => {
    for (const m of ['ok start', 'Okay, start.', 'yes go ahead', 'sure, begin', 'start now', 'start please', 'Start it up!']) {
      expect(wantsStart(m)).toBe(true);
    }
  });

  it('never claims a sentence that is describing the run', () => {
    // Each of these contains a start word and means something else entirely. A
    // substring test would arm a run on every one of them.
    for (const m of ['start with $50', 'I want to start trading with $100', 'start over', 'restart', 'when does it start?', 'go bold', 'go big', 'start small, $10']) {
      expect(wantsStart(m)).toBe(false);
    }
  });

  it('leaves the bold-style slang alone', () => {
    // "send it" / "go big" / "yolo" are how a trader says BOLD. If start stole them,
    // saying how you want to trade would begin trading.
    for (const m of ['send it', 'send it, let it rip', 'go big', 'yolo', 'swing for it']) {
      expect(wantsStart(m)).toBe(false);
      expect(parseSetup(m).preset === 'bold' || !parseSetup(m).presetNamed).toBe(true);
    }
    expect(parseSetup('send it').preset).toBe('bold');
    expect(parseSetup('go big').preset).toBe('bold');
  });

  it('handles junk without throwing', () => {
    for (const m of ['', '   ', '!!!', '???']) expect(wantsStart(m)).toBe(false);
  });
});
