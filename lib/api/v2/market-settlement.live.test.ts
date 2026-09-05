/**
 * Live: settlement read across deployments. Both markets below are real and settled, and
 * they come from different deployments. The 8-06 one is exactly the shape that sat on
 * "Awaiting settle" in Kelly's track record after the 9-04 cutover to 8-21: settled on
 * chain for two weeks, unreadable through the 8-21 package.
 *
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/api/v2/market-settlement.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { onchainMarketDeployment, onchainMarketSettlement } from './onchain';
import { toFloat } from '@/config/scale';

const RUN = process.env.RUN_LIVE === '1';
/** 8-06 market, expired 2026-08-21 01:56Z, settled at $75,360.51. */
const M_806 = '0xe9d43c921d51aead4b6437dd608ab6e26c5f99a2bf7b13fd170212366b65f80f';
/** 8-21 market, expired 2026-09-04 14:25Z, settled at $79,316.62. */
const M_821 = '0x00f556f45ea383a6f7cf37749592ddd10307e4ea9f36dedb9bca984a2b1e6f60';

describe.skipIf(!RUN)('market settlement across deployments (live)', () => {
  it('reads the deployment from the object type', async () => {
    expect(await onchainMarketDeployment(M_806)).toBe('8-06');
    expect(await onchainMarketDeployment(M_821)).toBe('8-21');
  }, 60_000);

  it('settles an 8-06 market while running on 8-21, with and without a hint', async () => {
    const plain = await onchainMarketSettlement(M_806);
    expect(plain.deployment).toBe('8-06');
    expect(plain.settlementPrice).not.toBeNull();
    expect(toFloat(plain.settlementPrice!)).toBeCloseTo(75_360.51, 1);
    // A wrong hint costs one failed read and then lands on the same answer.
    const wrongHint = await onchainMarketSettlement(M_806, '8-21');
    expect(wrongHint.deployment).toBe('8-06');
    expect(wrongHint.settlementPrice).toBe(plain.settlementPrice);
  }, 60_000);

  it('still reads the active deployment the short way', async () => {
    const r = await onchainMarketSettlement(M_821, '8-21');
    expect(r.deployment).toBe('8-21');
    expect(toFloat(r.settlementPrice!)).toBeCloseTo(79_316.62, 1);
  }, 60_000);
});
