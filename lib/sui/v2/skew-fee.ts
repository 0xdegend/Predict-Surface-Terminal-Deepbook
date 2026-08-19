/**
 * lib/sui/v2/skew-fee.ts — the v2 Skew fee (our `skew_fee_v2::fee_router`).
 *
 * A percentage of each bet, charged ON TOP of the protocol's native builder fee, in the
 * SAME PTB as the mint. Unlike v1 there is no Move wrapper around the mint (the v2 mint
 * signature churns every redeploy); instead we withdraw the fee from the trader's own
 * Account and hand that coin to `fee_router::charge`, which forwards it to the treasury and
 * emits `FeeCharged`. The on-chain `FeeConfig.fee_bps` governs the amount, so the admin
 * truly controls the fee; the front-end reads that same rate to size the withdrawal.
 *
 * The whole feature no-ops when the router isn't published for the active network
 * (`feeRouterV2Enabled` false) — mints fall back to the plain flow with no fee.
 */
import { Transaction, type TransactionResult } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config, feeRouterV2Enabled, v2SkewFeeTarget } from '@/config/predict';
import { addGenerateAuth, simulate, SIM_SENDER, type SimulateCapableClient } from './account';
import { POS_INF_TICK, NEG_INF_TICK } from './ticks';

const c = () => predictV2Config;
const ACC = (module: string, fn: string) => `${c().packages.account}::${module}::${fn}` as const;

/** Hard on-chain ceiling the admin can set (2.00%). Mirrors `MAX_FEE_BPS` in the Move package. */
export const SKEW_FEE_MAX_BPS = 200;
const BPS_DENOM = 10_000n;

/** The Skew fee (base units) for a bet `stake` (base units) at `feeBps`. Pure — the same
 *  `fee_bps * stake / 10_000` the Move `charge` recomputes, so the withdrawal matches exactly. */
export function skewFeeBase(stake: bigint, feeBps: number): bigint {
  if (feeBps <= 0 || stake <= 0n) return 0n;
  return (stake * BigInt(Math.round(feeBps))) / BPS_DENOM;
}

/** A binary leg carries a ±∞ sentinel tick; a range has two finite ticks. */
export function isRangeTicks(lowerTick: bigint, higherTick: bigint): boolean {
  return lowerTick !== NEG_INF_TICK && higherTick !== POS_INF_TICK;
}

export interface SkewFeeParams {
  wrapperId: string;
  /** The bet stake (net premium) the fee is a percentage of, base units. */
  stake: bigint;
  /** Live on-chain rate (basis points). */
  feeBps: number;
  /** The market being bet on (attribution only). */
  marketId: string;
  isRange: boolean;
}

/**
 * Append `generate_auth → account.withdraw_funds(fee) → fee_router::charge` to `tx`,
 * charging the Skew fee from the trader's Account to the treasury. Returns the fee taken
 * (base units) so the caller can size funding. No-op (returns 0) when the router is
 * disabled or the fee rounds to zero.
 *
 * MUST run after any deposit (so the account is funded) and before the mint (so the mint
 * still finds its cost). The account must therefore hold `cost + fee` at this point — the
 * ticket sizes its deposit for exactly that.
 */
export function addSkewFeeCharge(tx: Transaction, p: SkewFeeParams): bigint {
  if (!feeRouterV2Enabled) return 0n;
  const fee = skewFeeBase(p.stake, p.feeBps);
  if (fee <= 0n) return 0n;
  const auth = addGenerateAuth(tx);
  const feeCoin: TransactionResult = tx.moveCall({
    target: ACC('account', 'withdraw_funds'),
    typeArguments: [c().quote.coinType],
    arguments: [
      tx.object(p.wrapperId),
      auth,
      tx.pure.u64(fee),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  tx.moveCall({
    target: v2SkewFeeTarget('charge'),
    typeArguments: [c().quote.coinType],
    arguments: [
      tx.object(c().feeConfigV2Id),
      tx.pure.u64(p.stake),
      feeCoin,
      tx.pure.address(p.marketId),
      tx.pure.bool(p.isRange),
    ],
  });
  return fee;
}

/* -------------------------------- admin ---------------------------------- */

/** Retune the fee (basis points), gated on-chain by the AdminCap. */
export function buildSetSkewFeeBpsTx(adminCapId: string, feeBps: number): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: v2SkewFeeTarget('set_fee_bps'),
    arguments: [
      tx.object(adminCapId),
      tx.object(c().feeConfigV2Id),
      tx.pure.u64(BigInt(Math.round(feeBps))),
    ],
  });
  return tx;
}

/** Point the fee at a new treasury address, gated on-chain by the AdminCap. */
export function buildSetSkewTreasuryTx(adminCapId: string, treasury: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: v2SkewFeeTarget('set_treasury'),
    arguments: [tx.object(adminCapId), tx.object(c().feeConfigV2Id), tx.pure.address(treasury)],
  });
  return tx;
}

/* -------------------------------- reads ---------------------------------- */

export interface SkewFeeConfig {
  /** Rate in basis points (50 = 0.50%). */
  feeBps: number;
  /** Where the fee is sent. */
  treasury: string;
}

/** Read the live `FeeConfig` (rate + treasury) by simulate. Free — no signature, no gas. */
export async function readSkewFeeConfig(client: SimulateCapableClient): Promise<SkewFeeConfig> {
  const configId = c().feeConfigV2Id;
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  tx.moveCall({ target: v2SkewFeeTarget('fee_bps'), arguments: [tx.object(configId)] });
  tx.moveCall({ target: v2SkewFeeTarget('treasury'), arguments: [tx.object(configId)] });
  const res = await simulate(client, tx);
  const cmds = res.commandResults ?? [];
  if (cmds.length < 2) throw new Error('readSkewFeeConfig: simulate returned no values');
  return {
    feeBps: Number(bcs.u64().parse(new Uint8Array(cmds[0].returnValues[0].bcs))),
    treasury: bcs.Address.parse(new Uint8Array(cmds[1].returnValues[0].bcs)),
  };
}
