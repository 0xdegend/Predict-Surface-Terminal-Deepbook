/**
 * Which deployment an on-chain object came from, worked out from its Move type.
 *
 * The lookup exists because a market id stops being enough after a republish: the same
 * `expiry_market::ExpiryMarket` name exists under every deployment's package, and a view
 * getter from one package aborts on an object from another. Kelly's track record scores
 * calls made weeks apart, so it has to know which package to ask.
 */
import { describe, it, expect } from 'vitest';
import { deploymentForPredictPackage, predictConfigFor, KNOWN_V2_DEPLOYMENTS } from './predict';

describe('deploymentForPredictPackage', () => {
  it('names the deployment that defined an object, from a bare package or a full type', () => {
    const pkg806 = predictConfigFor('8-06').packages.predict;
    const pkg821 = predictConfigFor('8-21').packages.predict;
    expect(deploymentForPredictPackage(pkg806)).toBe('8-06');
    expect(deploymentForPredictPackage(`${pkg821}::expiry_market::ExpiryMarket`)).toBe('8-21');
  });

  it('compares addresses canonically and is null for a package that is not ours', () => {
    const pkg821 = predictConfigFor('8-21').packages.predict;
    expect(deploymentForPredictPackage(`0x${pkg821.slice(2).toUpperCase()}`)).toBe('8-21');
    expect(deploymentForPredictPackage('0x2::coin::Coin')).toBeNull();
    expect(deploymentForPredictPackage('')).toBeNull();
    expect(deploymentForPredictPackage('not-an-address::x::Y')).toBeNull();
  });

  it('maps every known deployment with a package back to itself', () => {
    for (const d of KNOWN_V2_DEPLOYMENTS) {
      const pkg = predictConfigFor(d).packages.predict;
      if (pkg) expect(deploymentForPredictPackage(pkg)).toBe(d);
    }
  });
});
