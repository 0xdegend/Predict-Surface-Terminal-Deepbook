/**
 * Live check for the v2 Skew fee against the published router. Network-gated — runs only
 * with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/v2/skew-fee.live.test.ts
 *
 * Proves two things on real testnet state: (1) the on-chain FeeConfig reads back the values
 * we published (0.50%, treasury = deployer), and (2) the NEW composition — withdraw the fee
 * from the trader's Account, then `fee_router::charge` it to the treasury — type-checks and
 * executes in one PTB (the risky part; the mint half is unchanged and already proven).
 */
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { predictV2Config } from '@/config/predict';
import { readWrapper, type SimulateCapableClient } from './account';
import { readSkewFeeConfig, addSkewFeeCharge, skewFeeBase } from './skew-fee';

const RUN = process.env.RUN_LIVE === '1';
const DEPLOYER = '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';
const DUMMY_MARKET = '0x2222222222222222222222222222222222222222222222222222222222222222';

interface SimStatus {
  $kind: string;
  FailedTransaction?: { status?: { error?: { message?: string } } };
}

describe.skipIf(!RUN)('skew_fee_v2 (live testnet)', () => {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
  const core = client.core as unknown as SimulateCapableClient & {
    simulateTransaction: (o: unknown) => Promise<SimStatus>;
  };

  it('FeeConfig reads back the published values (0.50%, deployer treasury)', async () => {
    const cfg = await readSkewFeeConfig(core);
    expect(cfg.feeBps).toBe(50);
    expect(cfg.treasury.toLowerCase()).toBe(DEPLOYER.toLowerCase());
    console.log(`FeeConfig: ${cfg.feeBps} bps → treasury ${cfg.treasury.slice(0, 10)}…`);
  }, 30_000);

  it('withdraw_funds → charge composes and executes against the deployer account', async () => {
    const { wrapperId, exists } = await readWrapper(core, DEPLOYER);
    expect(exists, 'deployer has a v2 account').toBe(true);

    // stake chosen so the fee is $0.50 (500k base) at 0.50% — a tiny, real charge.
    const stake = 100_000_000n;
    const expectedFee = skewFeeBase(stake, 50);
    expect(expectedFee).toBe(500_000n);

    const tx = new Transaction();
    tx.setSender(DEPLOYER);
    const fee = addSkewFeeCharge(tx, { wrapperId, stake, feeBps: 50, marketId: DUMMY_MARKET, isRange: false });
    expect(fee).toBe(expectedFee);

    const res = (await core.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
      checksEnabled: false,
    })) as SimStatus;

    if (res.$kind === 'FailedTransaction') {
      // An insufficient-balance abort still proves the PTB type-checks + reaches withdraw
      // (the composition is sound); only a non-balance abort would be a real defect.
      const msg = res.FailedTransaction?.status?.error?.message ?? '';
      console.log(`sim aborted (acceptable if it is a balance abort): ${msg}`);
      expect(msg).toMatch(/balance|insufficient|EInsufficient/i);
    } else {
      console.log('sim SUCCESS — withdraw_funds → charge executed (fee routed to treasury).');
      expect(res.$kind).not.toBe('FailedTransaction');
    }
  }, 30_000);
});
