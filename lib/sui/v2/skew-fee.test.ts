import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { skewFeeBase, isRangeTicks, addSkewFeeCharge } from './skew-fee';
import { buildMintBudgetTx } from './predict-tx';
import { POS_INF_TICK, NEG_INF_TICK } from './ticks';
import { predictV2Config, feeRouterV2Enabled } from '@/config/predict';

const MARKET = '0x2222222222222222222222222222222222222222222222222222222222222222';
const WRAPPER = '0x3333333333333333333333333333333333333333333333333333333333333333';

interface MoveCall {
  package: string;
  module: string;
  function: string;
  arguments: unknown[];
}
const moveCalls = (tx: { getData: () => { commands: unknown[] } }): MoveCall[] =>
  tx
    .getData()
    .commands.map((cmd) => (cmd as { MoveCall?: MoveCall }).MoveCall)
    .filter((c): c is MoveCall => !!c);

const hasCharge = (tx: Transaction) =>
  moveCalls(tx).some((c) => c.module === 'fee_router' && c.function === 'charge');
const hasWithdraw = (tx: Transaction) =>
  moveCalls(tx).some((c) => c.module === 'account' && c.function === 'withdraw_funds');

describe('skewFeeBase — fee = fee_bps * stake / 10_000 (floored), matches the Move charge', () => {
  it('0.50% of a $100 stake (100e6 base) is $0.50 (500k base)', () => {
    expect(skewFeeBase(100_000_000n, 50)).toBe(500_000n);
  });
  it('scales linearly with stake', () => {
    expect(skewFeeBase(200_000_000n, 50)).toBe(1_000_000n);
  });
  it('1.00% doubles 0.50%', () => {
    expect(skewFeeBase(100_000_000n, 100)).toBe(1_000_000n);
  });
  it('floors sub-unit results', () => {
    expect(skewFeeBase(199n, 50)).toBe(0n); // 199*50/10000 = 0.995 → 0
    expect(skewFeeBase(2000n, 50)).toBe(10n);
  });
  it('is zero when the rate or stake is zero/negative', () => {
    expect(skewFeeBase(100_000_000n, 0)).toBe(0n);
    expect(skewFeeBase(0n, 50)).toBe(0n);
    expect(skewFeeBase(-5n, 50)).toBe(0n);
  });
});

describe('isRangeTicks — a binary leg carries a ±∞ sentinel; a range has two finite ticks', () => {
  it('binary UP (higher = +∞) is not a range', () => {
    expect(isRangeTicks(5000n, POS_INF_TICK)).toBe(false);
  });
  it('binary DOWN (lower = −∞) is not a range', () => {
    expect(isRangeTicks(NEG_INF_TICK, 5000n)).toBe(false);
  });
  it('two finite ticks is a range', () => {
    expect(isRangeTicks(4000n, 6000n)).toBe(true);
  });
  it('both sentinels is not a range', () => {
    expect(isRangeTicks(NEG_INF_TICK, POS_INF_TICK)).toBe(false);
  });
});

describe('addSkewFeeCharge — appends withdraw_funds → fee_router::charge (router enabled here)', () => {
  it('config is published for the test network', () => {
    expect(feeRouterV2Enabled).toBe(true);
    expect(predictV2Config.skewFeeV2PackageId).toBeTruthy();
  });

  it('withdraws the exact fee from the account and hands it to charge', () => {
    const tx = new Transaction();
    const fee = addSkewFeeCharge(tx, {
      wrapperId: WRAPPER,
      stake: 100_000_000n,
      feeBps: 50,
      marketId: MARKET,
      isRange: false,
    });
    expect(fee).toBe(500_000n);
    expect(hasWithdraw(tx)).toBe(true);
    expect(hasCharge(tx)).toBe(true);
    // charge is called into our published skew_fee_v2 package.
    const charge = moveCalls(tx).find((c) => c.module === 'fee_router')!;
    expect(charge.package).toBe(predictV2Config.skewFeeV2PackageId);
  });

  it('is a no-op when the rate rounds to zero (no commands added)', () => {
    const tx = new Transaction();
    const fee = addSkewFeeCharge(tx, {
      wrapperId: WRAPPER,
      stake: 100_000_000n,
      feeBps: 0,
      marketId: MARKET,
      isRange: false,
    });
    expect(fee).toBe(0n);
    expect(moveCalls(tx)).toHaveLength(0);
  });
});

describe('buildMintBudgetTx — carries the charge only when a skewFee is supplied', () => {
  const base = {
    marketId: MARKET,
    wrapperId: WRAPPER,
    lowerTick: 1n,
    higherTick: 2n,
    amount: 100_000_000n,
    minQuantity: 1n,
    leverage: 1_000_000_000n,
  };

  it('includes the fee charge (before the mint) when skewFee is passed', () => {
    const tx = buildMintBudgetTx({ ...base, skewFee: { stake: 100_000_000n, feeBps: 50, isRange: true } });
    const calls = moveCalls(tx);
    expect(hasCharge(tx)).toBe(true);
    // The charge must precede the mint (it reads the account cost after the fee is out).
    const chargeIdx = calls.findIndex((c) => c.module === 'fee_router');
    const mintIdx = calls.findIndex((c) => c.function === 'mint_exact_amount');
    expect(chargeIdx).toBeGreaterThanOrEqual(0);
    expect(mintIdx).toBeGreaterThan(chargeIdx);
  });

  it('has no fee call when skewFee is omitted', () => {
    const tx = buildMintBudgetTx(base);
    expect(moveCalls(tx).some((c) => c.module === 'fee_router')).toBe(false);
  });
});
