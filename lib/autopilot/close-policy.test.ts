import { describe, it, expect } from 'vitest';
import {
  closeDecision,
  leanTurnedAgainst,
  closeReasonLabel,
  isClose,
  DEFAULT_CLOSE_CONFIG,
  type OpenRead,
  type CloseCode,
} from './close-policy';

const cfg = DEFAULT_CLOSE_CONFIG;

/** A neutral live UP position: in profit, plenty of time, read still for us. */
function read(over: Partial<OpenRead> = {}): OpenRead {
  return { side: 'up', markFrac: 0.5, inProfit: true, leanAgainst: false, timeLeftMs: 5 * 60_000, ...over };
}

describe('leanTurnedAgainst', () => {
  it('a clear opposite lean is against a directional bet', () => {
    expect(leanTurnedAgainst('up', { pick: 'down', confidence: 'clear' })).toBe(true);
    expect(leanTurnedAgainst('down', { pick: 'up', confidence: 'clear' })).toBe(true);
  });

  it('a merely slight lean never counts — that is the "not sideways" guard', () => {
    expect(leanTurnedAgainst('up', { pick: 'down', confidence: 'slight' })).toBe(false);
  });

  it('a lean the SAME way as the position is not against it', () => {
    expect(leanTurnedAgainst('up', { pick: 'up', confidence: 'clear' })).toBe(false);
  });

  it('no read at all is not against anything', () => {
    expect(leanTurnedAgainst('up', null)).toBe(false);
  });

  it('a band is broken by a CLEAR directional read either way, not by a range read', () => {
    expect(leanTurnedAgainst('range', { pick: 'up', confidence: 'clear' })).toBe(true);
    expect(leanTurnedAgainst('range', { pick: 'down', confidence: 'clear' })).toBe(true);
    expect(leanTurnedAgainst('range', { pick: 'range', confidence: 'clear' })).toBe(false);
    expect(leanTurnedAgainst('range', { pick: 'up', confidence: 'slight' })).toBe(false);
  });
});

describe('closeDecision', () => {
  it('holds a winning position while the read still favours it (let it run)', () => {
    expect(closeDecision(read({ markFrac: 0.6, inProfit: true, leanAgainst: false }), cfg)).toBe('hold');
  });

  it('banks a deep-in-the-money position regardless of the read', () => {
    expect(closeDecision(read({ markFrac: 0.8, leanAgainst: false }), cfg)).toBe('lock_deep_itm');
    expect(closeDecision(read({ markFrac: 0.95, leanAgainst: false }), cfg)).toBe('lock_deep_itm');
  });

  it('banks profit when the read turns clearly against us', () => {
    expect(closeDecision(read({ markFrac: 0.55, inProfit: true, leanAgainst: true }), cfg)).toBe('take_profit_adverse');
  });

  it('cuts a loser with time left when the read says it will not recover', () => {
    const d = closeDecision(read({ markFrac: 0.2, inProfit: false, leanAgainst: true, timeLeftMs: 5 * 60_000 }), cfg);
    expect(d).toBe('cut_loss_no_recover');
  });

  it('does NOT cut a loser too near expiry — it may revert and its max loss is already paid', () => {
    const d = closeDecision(read({ markFrac: 0.2, inProfit: false, leanAgainst: true, timeLeftMs: 90_000 }), cfg);
    expect(d).toBe('hold');
  });

  it('holds a loser when the read is not a clear reversal (it may still come back)', () => {
    const d = closeDecision(read({ markFrac: 0.2, inProfit: false, leanAgainst: false, timeLeftMs: 5 * 60_000 }), cfg);
    expect(d).toBe('hold');
  });

  it('never closes inside the min-time floor, even deep ITM (a winner is keeper-redeemed free)', () => {
    expect(closeDecision(read({ markFrac: 0.95, timeLeftMs: 30_000 }), cfg)).toBe('hold');
    expect(closeDecision(read({ markFrac: 0.55, inProfit: true, leanAgainst: true, timeLeftMs: 30_000 }), cfg)).toBe('hold');
  });

  it('deep-ITM takes priority over an adverse read (both closing, but labelled as the lock)', () => {
    expect(closeDecision(read({ markFrac: 0.85, inProfit: true, leanAgainst: true }), cfg)).toBe('lock_deep_itm');
  });
});

describe('isClose / closeReasonLabel', () => {
  it('every code but hold is a close', () => {
    expect(isClose('hold')).toBe(false);
    for (const c of ['lock_deep_itm', 'take_profit_adverse', 'cut_loss_no_recover'] as CloseCode[]) {
      expect(isClose(c)).toBe(true);
    }
  });

  it('labels are distinct and non-empty for the log', () => {
    const codes: CloseCode[] = ['hold', 'lock_deep_itm', 'take_profit_adverse', 'cut_loss_no_recover'];
    const labels = codes.map(closeReasonLabel);
    expect(new Set(labels).size).toBe(codes.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
  });
});
