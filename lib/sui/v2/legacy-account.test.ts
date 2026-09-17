/**
 * The guard on carrying a stranded balance forward.
 *
 * Every republish up to 8-21 reused `dusdc::DUSDC`, so the one-PTB move from the old
 * account to the new one always type-checked and nothing had to think about it. 9-12
 * publishes its own `usdc::USDC`, and a PTB that hands `withdraw_funds`'s `Coin<DUSDC>` to
 * `deposit_funds<USDC>` is rejected by the chain. This pins the check that catches that
 * before a trader is shown a banner and asked for a signature.
 */
import { describe, it, expect } from 'vitest';
import { canMoveFunds, buildLegacyMoveTx } from './legacy-account';
import { predictConfigFor, predictV2Config, KNOWN_V2_DEPLOYMENTS, type PredictDeployment } from '@/config/predict';

const args = (from: PredictDeployment) => ({
  from,
  oldWrapperId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  newWrapperId: '0x2222222222222222222222222222222222222222222222222222222222222222',
  amount: 1_000_000n,
  createAccount: false,
});

describe('canMoveFunds: the move needs one coin on both sides', () => {
  it('agrees with the two deployments settling in the same coin type', () => {
    for (const d of KNOWN_V2_DEPLOYMENTS) {
      const same = predictConfigFor(d).quote.coinType === predictV2Config.quote.coinType;
      expect(canMoveFunds(d), `${d} vs active`).toBe(same);
    }
  });

  it('is true for a deployment against itself, whatever the active one is', () => {
    // A trivial identity, and the reason the check is about coins rather than about which
    // release is newer: nothing here cares about ordering.
    const active = KNOWN_V2_DEPLOYMENTS.find((d) => predictConfigFor(d).quote.coinType === predictV2Config.quote.coinType);
    expect(active, 'the active deployment must match itself').toBeDefined();
  });
});

describe('buildLegacyMoveTx refuses what the chain would reject', () => {
  it('throws for a deployment settling in a different coin, naming both', () => {
    const mismatched = KNOWN_V2_DEPLOYMENTS.filter((d) => !canMoveFunds(d));
    for (const d of mismatched) {
      expect(() => buildLegacyMoveTx(args(d)), d).toThrow(/cannot move funds|Withdraw to the wallet/i);
    }
  });

  it('still builds for a deployment settling in the same coin', () => {
    const matched = KNOWN_V2_DEPLOYMENTS.filter((d) => canMoveFunds(d));
    expect(matched.length, 'no deployment shares the active coin, not even the active one').toBeGreaterThan(0);
    for (const d of matched) expect(() => buildLegacyMoveTx(args(d)), d).not.toThrow();
  });
});
