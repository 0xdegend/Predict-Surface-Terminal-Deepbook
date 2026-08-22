import { describe, it, expect } from 'vitest';
import { shouldRetireRoot } from './retire-root';
import { humanizeV2Error } from '@/lib/sui/v2/abort';

const abort = (mod: string, code: number) =>
  humanizeV2Error(
    new Error(`MoveAbort in 7th command, abort code: ${code}, in '0xdb3e::${mod}::close' (instruction 9)`),
  );

describe('shouldRetireRoot', () => {
  it('retires a successful FULL close', () => {
    expect(shouldRetireRoot({ digest: '0xabc', fullClose: true, lastError: null })).toBe(true);
  });

  it('keeps a successful PARTIAL close — there is still a position left', () => {
    expect(shouldRetireRoot({ digest: '0xabc', fullClose: false, lastError: null })).toBe(false);
  });

  it('retires when the chain refuses because nothing is left (the keeper already paid it)', () => {
    // This is the 0xb11ec038… case: CLAIM kept failing, and the row kept coming back.
    expect(
      shouldRetireRoot({ digest: null, fullClose: true, lastError: abort('strike_exposure', 0) }),
    ).toBe(true);
  });

  it('retires on a refusal even when only part was being closed', () => {
    // If the chain says there is less than we asked for, the row is not trustworthy either way.
    expect(
      shouldRetireRoot({ digest: null, fullClose: false, lastError: abort('predict_account', 1) }),
    ).toBe(true);
  });

  it('NEVER retires on failures where the position still exists', () => {
    for (const [mod, code] of [
      ['expiry_market', 4],
      ['expiry_market', 5],
      ['strike_exposure', 4],
      ['strike_exposure', 7],
      ['account', 1],
      ['pricing', 4],
    ] as const) {
      expect(
        shouldRetireRoot({ digest: null, fullClose: true, lastError: abort(mod, code) }),
        `${mod}:${code}`,
      ).toBe(false);
    }
  });

  it('never retires on a wallet rejection or a missing error', () => {
    const rejected = humanizeV2Error(new Error('User rejected the request'));
    expect(shouldRetireRoot({ digest: null, fullClose: true, lastError: rejected })).toBe(false);
    expect(shouldRetireRoot({ digest: null, fullClose: true, lastError: null })).toBe(false);
  });
});
