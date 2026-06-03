/**
 * lib/sui/config.ts — read Predict config getters from chain via simulate.
 * These aren't in the server /state payload (returns null), so we read them
 * directly: trading_paused, base_spread, min_spread, utilization_multiplier,
 * max_total_exposure_pct. All u64 values are 1e9-scaled (→ floats here).
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictConfig } from '@/config/predict';
import { toFloat } from '@/config/scale';
import type { SimulateCapableClient } from './quote';

export interface PredictConfigRead {
  tradingPaused: boolean;
  baseSpread: number; // fraction (1e9-scaled → float)
  minSpread: number;
  utilizationMultiplier: number;
  maxTotalExposurePct: number; // fraction of vault capital (e.g. 0.8)
}

const GETTERS = [
  'trading_paused',
  'base_spread',
  'min_spread',
  'utilization_multiplier',
  'max_total_exposure_pct',
] as const;

export async function readPredictConfig(
  client: SimulateCapableClient,
  sender: string,
): Promise<PredictConfigRead> {
  const tx = new Transaction();
  tx.setSender(sender);
  for (const fn of GETTERS) {
    tx.moveCall({
      target: `${predictConfig.packageId}::predict::${fn}`,
      arguments: [tx.object(predictConfig.predictObjectId)],
    });
  }
  const res = (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as {
    $kind: string;
    commandResults?: { returnValues: { bcs: Uint8Array }[] }[];
  };
  if (res.$kind === 'FailedTransaction' || !res.commandResults) {
    throw new Error('config simulate failed');
  }
  const out = res.commandResults.map((c) => c.returnValues[0].bcs);
  return {
    tradingPaused: bcs.bool().parse(out[0]),
    baseSpread: toFloat(Number(bcs.u64().parse(out[1]))),
    minSpread: toFloat(Number(bcs.u64().parse(out[2]))),
    utilizationMultiplier: toFloat(Number(bcs.u64().parse(out[3]))),
    maxTotalExposurePct: toFloat(Number(bcs.u64().parse(out[4]))),
  };
}
