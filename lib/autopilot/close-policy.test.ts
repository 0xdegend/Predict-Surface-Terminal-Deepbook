import { describe, it, expect } from 'vitest';
import {
  closeDecision,
  leanTurnedAgainst,
  closeReasonLabel,
  isClose,
  DEFAULT_CLOSE_CONFIG,
  type OpenRead,
  type CloseCode,
  type CloseConfig,
} from './close-policy';
import { CLOSE_CONFIG } from './presets';

const balanced = DEFAULT_CLOSE_CONFIG; // Balanced == the default

/** A neutral live UP position: modest profit, plenty of time, read still for us. */
function read(over: Partial<OpenRead> = {}): OpenRead {
  return { side: 'up', markFrac: 0.5, gainOnCost: 0.2, leanAgainst: false, timeLeftMs: 5 * 60_000, ...over };
}

describe('leanTurnedAgainst', () => {
  it('a clear opposite lean is against a directional bet', () => {
    expect(leanTurnedAgainst('up', { pick: 'down', confidence: 'clear' })).toBe(true);
    expect(leanTurnedAgainst('down', { pick: 'up', confidence: 'clear' })).toBe(true);
  });
  it('a merely slight lean never counts — the "not sideways" guard', () => {
    expect(leanTurnedAgainst('up', { pick: 'down', confidence: 'slight' })).toBe(false);
  });
  it('a lean the SAME way, or no read, is not against it', () => {
    expect(leanTurnedAgainst('up', { pick: 'up', confidence: 'clear' })).toBe(false);
    expect(leanTurnedAgainst('up', null)).toBe(false);
  });
  it('a band is broken by a CLEAR directional read either way, not by a range read', () => {
    expect(leanTurnedAgainst('range', { pick: 'up', confidence: 'clear' })).toBe(true);
    expect(leanTurnedAgainst('range', { pick: 'down', confidence: 'clear' })).toBe(true);
    expect(leanTurnedAgainst('range', { pick: 'range', confidence: 'clear' })).toBe(false);
  });
});

describe('closeDecision — Balanced (default)', () => {
  it('holds a winning position while the read still favours it', () => {
    expect(closeDecision(read({ markFrac: 0.6, gainOnCost: 0.2, leanAgainst: false }), balanced)).toBe('hold');
  });
  it('banks a deep-in-the-money position regardless of the read', () => {
    expect(closeDecision(read({ markFrac: 0.8, leanAgainst: false }), balanced)).toBe('lock_deep_itm');
  });
  it('banks profit when the read turns clearly against us', () => {
    expect(closeDecision(read({ markFrac: 0.55, gainOnCost: 0.15, leanAgainst: true }), balanced)).toBe('take_profit_adverse');
  });
  it('stops out a big loss (>=60% of stake) with time left, no read needed', () => {
    expect(closeDecision(read({ markFrac: 0.2, gainOnCost: -0.6, leanAgainst: false, timeLeftMs: 5 * 60_000 }), balanced)).toBe('stop_loss');
  });
  it('cuts a smaller loser only when the read says no recovery', () => {
    expect(closeDecision(read({ markFrac: 0.3, gainOnCost: -0.2, leanAgainst: true, timeLeftMs: 5 * 60_000 }), balanced)).toBe('cut_loss_no_recover');
    expect(closeDecision(read({ markFrac: 0.3, gainOnCost: -0.2, leanAgainst: false, timeLeftMs: 5 * 60_000 }), balanced)).toBe('hold');
  });
  it('does NOT cut a loser too near expiry — it may revert', () => {
    expect(closeDecision(read({ gainOnCost: -0.2, leanAgainst: true, timeLeftMs: 90_000 }), balanced)).toBe('hold');
    expect(closeDecision(read({ gainOnCost: -0.7, leanAgainst: false, timeLeftMs: 90_000 }), balanced)).toBe('hold');
  });
  it('never closes inside the min-time floor', () => {
    expect(closeDecision(read({ markFrac: 0.95, timeLeftMs: 30_000 }), balanced)).toBe('hold');
  });
  it('has NO profit-on-cost target — a +40% winner with a friendly read rides', () => {
    expect(closeDecision(read({ markFrac: 0.6, gainOnCost: 0.4, leanAgainst: false }), balanced)).toBe('hold');
  });
});

describe('closeDecision — Careful (banks early, hard stop)', () => {
  const careful = CLOSE_CONFIG.cautious;
  it('takes profit at the +30% target even with a friendly read', () => {
    expect(closeDecision(read({ markFrac: 0.5, gainOnCost: 0.3, leanAgainst: false }), careful)).toBe('take_profit_target');
  });
  it('locks a near-win earlier than Balanced (70% of payout)', () => {
    expect(closeDecision(read({ markFrac: 0.7, gainOnCost: 0.5 }), careful)).toBe('lock_deep_itm');
  });
  it('stops a loss at -40%, tighter than Balanced', () => {
    expect(closeDecision(read({ markFrac: 0.3, gainOnCost: -0.4, leanAgainst: false, timeLeftMs: 5 * 60_000 }), careful)).toBe('stop_loss');
  });
  it('can cut with less time left than Balanced (90s floor)', () => {
    expect(closeDecision(read({ gainOnCost: -0.2, leanAgainst: true, timeLeftMs: 100_000 }), careful)).toBe('cut_loss_no_recover');
  });
});

describe('closeDecision — Bold (rides to expiry)', () => {
  const bold = CLOSE_CONFIG.bold;
  it('never closes: not on deep profit, not on a huge loss, not on an adverse read', () => {
    expect(closeDecision(read({ markFrac: 0.99, gainOnCost: 2, leanAgainst: true }), bold)).toBe('hold');
    expect(closeDecision(read({ markFrac: 0.05, gainOnCost: -0.95, leanAgainst: true, timeLeftMs: 8 * 60_000 }), bold)).toBe('hold');
  });
});

describe('ordering + helpers', () => {
  it('deep-ITM takes priority over the profit target', () => {
    const cfg: CloseConfig = { ...CLOSE_CONFIG.cautious };
    expect(closeDecision(read({ markFrac: 0.85, gainOnCost: 0.5 }), cfg)).toBe('lock_deep_itm');
  });
  it('every code but hold is a close, and labels are distinct', () => {
    const codes: CloseCode[] = ['hold', 'lock_deep_itm', 'take_profit_target', 'take_profit_adverse', 'stop_loss', 'cut_loss_no_recover'];
    expect(isClose('hold')).toBe(false);
    expect(codes.filter((c) => c !== 'hold').every(isClose)).toBe(true);
    const labels = codes.map(closeReasonLabel);
    expect(new Set(labels).size).toBe(codes.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
  });
});
