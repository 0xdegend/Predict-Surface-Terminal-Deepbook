/**
 * lib/sui/v2/pricer.ts — the v2 read-only quote spine.
 *
 * The new protocol has no public `get_trade_amounts`. Instead it builds a per-tx
 * `Pricer` snapshot via `expiry_market::load_live_pricer` (public, read-only) and
 * feeds it into mint/redeem. `Pricer { expiry_market_id, forward, svi }` is
 * copy+drop, so we can SIMULATE the call and BCS-decode the returned Pricer to get
 * the live forward + SVI the protocol prices against — no wallet, no funds.
 *
 * Fair UP/DN/range probabilities are then computed CLIENT-SIDE with lib/svi (which
 * mirrors the on-chain SVI math). This is the fair MID; the authoritative all-in
 * cost (fees + leverage + admission spread) comes from simulating mint_exact_quantity
 * once the account model lands in Phase 2. (`up_price`/`range_price` are package-
 * private on-chain, so the fair mid is the only read-only price available here.)
 *
 * BCS layout verified from source (branch predict-testnet-6-24):
 *   Pricer  { expiry_market_id: address, forward: u64, svi: SVIParams }
 *   SVIParams { a: u64, b: u64, rho: I64, m: I64, sigma: u64 }
 *   I64     { magnitude: u64, is_negative: bool }
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, ACTIVE_NETWORK, v2Target } from '@/config/predict';
import { toFloat, signedToFloat } from '@/config/scale';
import { upFair, dnFair, rangeFair, type SviFloat } from '@/lib/svi/svi';

/* ------------------------------- BCS shapes ------------------------------ */

const I64 = bcs.struct('I64', { magnitude: bcs.u64(), is_negative: bcs.bool() });
const SVIParamsBcs = bcs.struct('SVIParams', {
  a: bcs.u64(),
  b: bcs.u64(),
  rho: I64,
  m: I64,
  sigma: bcs.u64(),
});
const PricerBcs = bcs.struct('Pricer', {
  expiry_market_id: bcs.Address,
  forward: bcs.u64(),
  svi: SVIParamsBcs,
});

/* ------------------------------- client ---------------------------------- */

/** Minimal client surface we need (a SuiGrpcClient satisfies this). */
export interface SimulateCapableClient {
  simulateTransaction: (opts: {
    transaction: Transaction;
    include?: { commandResults?: boolean };
    checksEnabled?: boolean;
  }) => Promise<unknown>;
}

interface SimulateResult {
  $kind: string;
  commandResults?: { returnValues: { bcs: Uint8Array }[] }[];
  FailedTransaction?: { status?: { error?: unknown } };
}

// A read-only simulate needs a sender but never signs or spends. Fixed dummy.
const SIM_SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

/** Lazily-created gRPC client for v2 reads (server / script / non-hook contexts). */
let _grpc: SuiGrpcClient | null = null;
export function v2GrpcClient(): SuiGrpcClient {
  return (_grpc ??= new SuiGrpcClient({
    network: ACTIVE_NETWORK,
    baseUrl: predictV2Config.grpcUrl,
  }));
}

/* ------------------------------- pricer ---------------------------------- */

/** Live pricing snapshot, de-scaled to floats for client math. */
export interface LivePricer {
  expiryMarketId: string;
  forward: number;
  svi: SviFloat;
}

/**
 * Add a `load_live_pricer` moveCall to a tx and return its result handle. Reused
 * by the mint/redeem builders in Phase 2 (which need a `&Pricer` argument).
 */
export function buildLoadPricerCall(tx: Transaction, marketId: string) {
  const c = predictV2Config;
  return tx.moveCall({
    target: v2Target('expiry_market', 'load_live_pricer'),
    arguments: [
      tx.object(marketId),
      tx.object(c.shared.protocolConfig),
      tx.object(c.shared.oracleRegistry),
      tx.object(c.asset.pythFeedId),
      tx.object(c.asset.bsSpotFeedId),
      tx.object(c.asset.bsForwardFeedId),
      tx.object(c.asset.bsSviFeedId),
      tx.object(c.clockId),
    ],
  });
}

/**
 * Simulate `load_live_pricer` for a market and decode the returned Pricer.
 * Throws with the on-chain abort if the feeds are stale or the market expired
 * (load_live_pricer aborts in those cases — surface that to the caller).
 */
export async function simulateLivePricer(
  client: SimulateCapableClient,
  marketId: string,
): Promise<LivePricer> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  buildLoadPricerCall(tx, marketId);
  const res = (await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  })) as SimulateResult;

  if (res.$kind === 'FailedTransaction') {
    const err = res.FailedTransaction?.status?.error;
    const msg = typeof err === 'string' ? err : (err as { message?: string })?.message ?? 'simulate failed';
    throw new Error(`load_live_pricer simulate failed: ${msg}`);
  }
  const last = res.commandResults?.at(-1);
  if (!last?.returnValues?.length) {
    throw new Error('load_live_pricer returned no Pricer (read-only call expected)');
  }
  const p = PricerBcs.parse(new Uint8Array(last.returnValues[0].bcs));
  return {
    expiryMarketId: p.expiry_market_id,
    forward: toFloat(p.forward),
    svi: {
      a: toFloat(p.svi.a),
      b: toFloat(p.svi.b),
      rho: signedToFloat(p.svi.rho.magnitude, p.svi.rho.is_negative),
      m: signedToFloat(p.svi.m.magnitude, p.svi.m.is_negative),
      sigma: toFloat(p.svi.sigma),
    },
  };
}

/* ----------------------------- fair prices ------------------------------- */
/* Client-side fair MID off the live Pricer (visualization + preview only). */

export const fairUp = (p: LivePricer, strike: number) => upFair(strike, p.forward, p.svi);
export const fairDn = (p: LivePricer, strike: number) => dnFair(strike, p.forward, p.svi);
export const fairRange = (p: LivePricer, lower: number, higher: number) =>
  rangeFair(lower, higher, p.forward, p.svi);
