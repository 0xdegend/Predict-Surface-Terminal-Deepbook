/**
 * Golden-value check (§6.5): the client SVI fair price must match the chain's
 * get_trade_amounts MID (spread removed) within tolerance. If these diverge, the
 * surface is lying. Network-gated — runs only with RUN_GOLDEN=1:
 *
 *   RUN_GOLDEN=1 npx vitest run lib/svi/golden.live.test.ts
 *
 * Reuses the real lib/svi math and lib/sui/quote path (no duplicated math).
 */
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictConfig } from '@/config/predict';
import { toFloat } from '@/config/scale';
import { parseSvi, upFair } from './svi';
import { snapStrikeToTick } from '@/lib/keys';
import { quoteMarket, type SimulateCapableClient } from '@/lib/sui/quote';
import { getOracles, getLatestSvi } from '@/lib/api/client';

const RUN = process.env.RUN_GOLDEN === '1';
const SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

/** Read the oracle's CURRENT forward from chain (removes ~1s server staleness). */
async function chainForward(client: SimulateCapableClient, oracleId: string): Promise<bigint> {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: `${predictConfig.packageId}::oracle::forward_price`,
    arguments: [tx.object(oracleId)],
  });
  const res = (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as { commandResults?: { returnValues: { bcs: Uint8Array }[] }[] };
  const last = res.commandResults![res.commandResults!.length - 1];
  return BigInt(bcs.u64().parse(last.returnValues[0].bcs));
}

describe.skipIf(!RUN)('golden: client fair price vs chain mid', () => {
  it('agrees within tolerance across strikes near the forward', async () => {
    const oracles = (await getOracles())
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.expiry - b.expiry);
    const oracle = oracles[0];
    const sviRaw = await getLatestSvi(oracle.oracle_id);
    const svi = parseSvi(sviRaw);

    const client = new SuiGrpcClient({
      network: 'testnet',
      baseUrl: predictConfig.grpcUrl,
    });

    // Use the chain's CURRENT forward, not the lagging server snapshot — forward
    // moves ~$10-50/s and dominates the residual for ATM binaries.
    const forwardScaled = Number(await chainForward(client.core, oracle.oracle_id));
    const forward = toFloat(forwardScaled);

    const qty = 1_000_000n; // 1 contract
    const atm = snapStrikeToTick(BigInt(forwardScaled), oracle);
    const tick = BigInt(oracle.tick_size);

    let maxDiff = 0;
    for (const off of [-4n, -1n, 0n, 1n, 4n]) {
      const strikeScaled = atm + off * tick;
      const strike = toFloat(Number(strikeScaled));

      const chain = await quoteMarket(client.core, {
        sender: SENDER,
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        strike: strikeScaled,
        isUp: true,
        quantity: qty,
      });
      // Chain mid (spread removed) per unit, in [0,1].
      const chainMid = (Number(chain.mintCost) + Number(chain.redeemPayout)) / 2 / Number(qty);
      const clientUp = upFair(strike, forward, svi);

      const diff = Math.abs(clientUp - chainMid);
      maxDiff = Math.max(maxDiff, diff);
      console.log(
        `K=${strike.toFixed(0)} client=${clientUp.toFixed(6)} chainMid=${chainMid.toFixed(6)} diff=${diff.toExponential(2)}`,
      );
      // Tolerance: 0.5 cents on a $1 binary — well above float noise, below spread.
      expect(diff).toBeLessThan(5e-3);
    }
    console.log(`max diff = ${maxDiff.toExponential(3)}`);
  }, 30_000);
});
