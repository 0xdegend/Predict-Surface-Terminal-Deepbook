import { describe, it, expect } from 'vitest';
import { expectedMove } from './expected-move';
import { totalVariance, type SviFloat } from '@/lib/svi/svi';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };

describe('expectedMove', () => {
  it('is the surface 1σ: sqrt(total variance) at the ATM forward', () => {
    const em = expectedMove({ forward: 65_000, svi: SVI })!;
    expect(em.sigma).toBeCloseTo(Math.sqrt(totalVariance(65_000, 65_000, SVI)), 12);
  });

  it('centers a symmetric band on the forward', () => {
    const em = expectedMove({ forward: 65_000, svi: SVI })!;
    expect(em.lowPrice).toBeLessThan(em.forward);
    expect(em.highPrice).toBeGreaterThan(em.forward);
    expect(em.forward - em.lowPrice).toBeCloseTo(em.highPrice - em.forward, 6);
  });

  it('returns null when it cannot produce a finite positive sigma', () => {
    expect(expectedMove({ forward: 0, svi: SVI })).toBeNull();
    expect(expectedMove({ forward: -1, svi: SVI })).toBeNull();
  });
});
