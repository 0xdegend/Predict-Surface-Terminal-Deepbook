import { describe, it, expect } from 'vitest';
import { humanizeError, isInsufficientGas } from './abort';

const PKG = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';

describe('humanizeError', () => {
  it('maps the far-OTM pricing abort (the real one users hit)', () => {
    const msg = `quote simulate failed: MoveAbort in 2nd command, abort code: 1, in '${PKG}::pricing_config::quote_spread_from_fair_price' (instruction 17)`;
    expect(humanizeError(new Error(msg))).toMatch(/too far from the current price/i);
  });

  it('maps expiry mismatch and off-grid strike distinctly', () => {
    expect(humanizeError(`MoveAbort abort code: 1, in '${PKG}::oracle_config::assert_key_matches' (instruction 31)`)).toMatch(
      /expired or refreshed/i,
    );
    expect(humanizeError(`MoveAbort abort code: 2, in '${PKG}::oracle_config::assert_valid_strike' (instruction 35)`)).toMatch(
      /grid/i,
    );
  });

  it('maps ask-bounds + paused', () => {
    expect(humanizeError(`abort code: 7, in '${PKG}::predict::mint'`)).toMatch(/1%.{0,3}99%|closer to spot/i);
    expect(humanizeError(`abort code: 0, in '${PKG}::predict::mint'`)).toMatch(/paused/i);
  });

  it('handles wallet outcomes', () => {
    expect(humanizeError(new Error('User rejected the request.'))).toMatch(/cancelled/i);
    expect(humanizeError(new Error('User closed the wallet window'))).toMatch(/closed/i);
    expect(humanizeError(new Error('Insufficient gas for this SUI transaction'))).toMatch(/testnet SUI/i);
    expect(humanizeError(new Error('getaddrinfo ENOTFOUND api.x'))).toMatch(/network/i);
  });

  it('turns the raw node gas-object rejection into plain wallet copy', () => {
    // The exact string a low-gas payer hits (session key OR wallet): the node's
    // input-object check rejects the gas coin before the tx ever runs.
    const raw = 'Error checking transaction input objects: Balance of gas object 19305360 is lower than the needed amount: 30000000';
    expect(isInsufficientGas(new Error(raw))).toBe(true);
    const out = humanizeError(new Error(raw));
    expect(out).toMatch(/network fee/i);
    expect(out).toMatch(/testnet SUI/i);
    // No node internals leak through.
    expect(out).not.toMatch(/gas object|input objects|\d{7,}/);
  });

  it('does not flag unrelated errors as a gas shortfall', () => {
    expect(isInsufficientGas(new Error('User rejected the request.'))).toBe(false);
    expect(isInsufficientGas(new Error('insufficient balance in your account'))).toBe(false);
  });

  it('maps wallet password / locked-vault errors as a recoverable wallet issue', () => {
    expect(humanizeError(new Error('Incorrect password'))).toMatch(/wallet/i);
    expect(humanizeError(new Error('Incorrect password'))).toMatch(/unlock/i);
    expect(humanizeError(new Error('Wallet is locked'))).toMatch(/unlock/i);
  });

  it('falls back gracefully', () => {
    expect(humanizeError(`MoveAbort abort code: 99, in '${PKG}::vault::foo'`)).toMatch(/vault #99/);
    expect(humanizeError('totally unknown')).toBe('totally unknown');
  });
});
