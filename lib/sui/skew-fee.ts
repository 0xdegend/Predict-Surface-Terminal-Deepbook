/**
 * lib/sui/skew-fee.ts — read the live Skew builder fee (basis points) from the
 * on-chain FeeConfig, so the UI always shows the real, currently-configured rate
 * rather than a hardcoded number. Uses the same read-only simulate path as quotes
 * (calls the public `fee_router::fee_bps(&FeeConfig): u64` getter, BCS-decodes).
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictConfig, feeRouterEnabled } from '@/config/predict';
import type { SimulateCapableClient } from './quote';

interface CommandResult {
  returnValues: { bcs: Uint8Array }[];
}
interface SimulateResult {
  $kind: string;
  commandResults?: CommandResult[];
  FailedTransaction?: { status?: { error?: unknown } };
}

/** Returns the configured builder fee in bps (100 = 1.00%), or 0 if the router
 *  isn't deployed for this network. `sender` only needs to be a valid address. */
export async function readSkewFeeBps(
  client: SimulateCapableClient,
  sender: string,
): Promise<number> {
  if (!feeRouterEnabled) return 0;
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${predictConfig.skewFeePackageId}::fee_router::fee_bps`,
    arguments: [tx.object(predictConfig.feeConfigId)],
  });
  const raw = (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as SimulateResult;
  if (raw.$kind === 'FailedTransaction') return 0;
  const last = raw.commandResults?.[raw.commandResults.length - 1];
  const val = last?.returnValues?.[0]?.bcs;
  if (!val) return 0;
  return Number(bcs.u64().parse(val));
}
