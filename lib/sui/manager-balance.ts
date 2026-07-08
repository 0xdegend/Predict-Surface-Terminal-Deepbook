/**
 * lib/sui/manager-balance.ts — on-chain read of a legacy PredictManager's free
 * quote balance.
 *
 * The legacy server's `/managers/:id/summary` began 500ing when its ingestion
 * lost JSON-RPC (2026-07-08). The trading balance it carried is authoritative
 * ON-CHAIN, so we read it directly: a gas-free simulate of
 * `predict_manager::balance<DUSDC>` (signature verified live via GraphQL:
 * `balance<T>(&PredictManager): u64`). Feeds the portfolio's fallback summary.
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictConfig } from '@/config/predict';
import type { SimulateCapableClient } from '@/lib/sui/v2/account';

const SIM_SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

interface SimResult {
  $kind: string;
  commandResults?: { returnValues: { bcs: Uint8Array }[] }[];
}

/** Free DUSDC sitting in the manager (base units), read from the chain. */
export async function readManagerTradingBalance(
  client: SimulateCapableClient,
  managerId: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  tx.moveCall({
    target: `${predictConfig.packageId}::predict_manager::balance`,
    typeArguments: [predictConfig.quote.coinType],
    arguments: [tx.object(managerId)],
  });
  const res = (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as SimResult;
  const value = res.commandResults?.[0]?.returnValues?.[0]?.bcs;
  if (!value) throw new Error('readManagerTradingBalance: simulate returned no value');
  return BigInt(bcs.u64().parse(new Uint8Array(value)));
}
