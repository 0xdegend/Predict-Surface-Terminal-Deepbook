import { describe, it, expect } from 'vitest';
import { humanizeV2Error, isPositionGoneMessage, ALREADY_CLAIMED_MESSAGE } from './abort';

/** The real node wording, matching the fixtures in abort.test.ts. */
const abort = (mod: string, code: number) =>
  new Error(`MoveAbort in 7th command, abort code: ${code}, in '0xdb3e::${mod}::close' (instruction 9)`);

describe('isPositionGoneMessage', () => {
  it('fires on the abort the keeper-redeemed position actually throws', () => {
    // strike_exposure:0 — "less open than you're trying to close". This is the one seen
    // on 0xb11ec038… : the keeper had already redeemed it, so the chain refused.
    const msg = humanizeV2Error(abort('strike_exposure', 0));
    expect(msg).toContain('less open than you');
    expect(isPositionGoneMessage(msg)).toBe(true);
  });

  it('fires on both "already claimed" registry aborts', () => {
    expect(isPositionGoneMessage(humanizeV2Error(abort('predict_account', 1)))).toBe(true);
    expect(isPositionGoneMessage(humanizeV2Error(abort('predict_account', 2)))).toBe(true);
  });

  it('fires on the VM underflow, which is the same situation without an assert', () => {
    const msg = humanizeV2Error(new Error('MovePrimitiveRuntimeError at ... SUB overflow'));
    expect(msg).toBe(ALREADY_CLAIMED_MESSAGE);
    expect(isPositionGoneMessage(msg)).toBe(true);
  });

  it('does NOT fire on failures where the position is still there', () => {
    // Retiring a row on any of these would hide a position the trader still owns.
    for (const [mod, code] of [
      ['expiry_market', 4], // cost moved above your limit
      ['expiry_market', 5], // odds moved past your limit
      ['strike_exposure', 4], // data changed while confirming
      ['strike_exposure', 7], // market data not ready
      ['account', 1], // not enough balance
      ['pricing', 4], // stale market data
    ] as const) {
      expect(isPositionGoneMessage(humanizeV2Error(abort(mod, code))), `${mod}:${code}`).toBe(false);
    }
  });

  it('does not fire on wallet rejection, network noise or nothing', () => {
    expect(isPositionGoneMessage(humanizeV2Error(new Error('User rejected the request')))).toBe(false);
    expect(isPositionGoneMessage(humanizeV2Error(new Error('fetch failed')))).toBe(false);
    expect(isPositionGoneMessage(null)).toBe(false);
    expect(isPositionGoneMessage('')).toBe(false);
  });
});
