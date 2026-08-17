import { describe, it, expect } from 'vitest';
import { parseSetup, resolveSetup } from './setup-parser';

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

  it('sizes the per-bet from the budget over the preset trade count when only a budget is named', () => {
    // Balanced runs up to 5 trades → $50 / 5 = $10 a bet.
    const r = resolveSetup(parseSetup('balanced $50'), CURRENT);
    expect(r.budgetUsd).toBe(50);
    expect(r.perTradeUsd).toBe(10);
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
