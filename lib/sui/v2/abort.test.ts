import { describe, it, expect } from 'vitest';
import { humanizeV2Error } from './abort';

describe('humanizeV2Error', () => {
  it('decodes the min-stake mint abort (strike_exposure_config #4) as seen from Slush', () => {
    // Verbatim wallet-surface format from a real failed mint.
    const raw =
      "Transaction resolution failed: MoveAbort in 7th command, abort code: 4, in '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e::strike_exposure_config::assert_mint_admission' (instruction 20)";
    expect(humanizeV2Error(raw)).toBe(
      'Bets need at least a $1 stake (before fees). Add a little and try again.',
    );
  });

  it('decodes the leverage admission cap abort (strike_exposure_config #6)', () => {
    const raw =
      "MoveAbort in 7th command, abort code: 6, in '0xdb3e::strike_exposure_config::assert_mint_admission' (instruction 9)";
    expect(humanizeV2Error(raw)).toBe(
      'That leverage is more than this market allows right now. Lower it and retry.',
    );
  });

  it('decodes the lot-size abort (order #4) distinctly from the min-stake one', () => {
    const raw =
      "MoveAbort in 7th command, abort code: 4, in '0xdb3e::order::assert_valid_quantity' (instruction 12)";
    expect(humanizeV2Error(raw)).toBe(
      'The position size didn’t land on the protocol’s size grid. Refresh and retry.',
    );
  });

  it('falls back to a generic module/code line for unmapped aborts', () => {
    const raw = "MoveAbort in 3rd command, abort code: 99, in '0xabc::expiry_market::mint_exact_quantity'";
    expect(humanizeV2Error(raw)).toBe('On-chain check failed (expiry_market #99).');
  });
});
