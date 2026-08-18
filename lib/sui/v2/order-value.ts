/**
 * order-value.ts — the AUTHORITATIVE "is this settled position already paid out?" read.
 *
 * The portfolio folds open positions from the order-event log, and the protocol keeper's
 * permissionless redeem of a settled winner is captured only by a rate-limited per-market
 * scan (see [[keeper-redeem-read-gap]]). When that scan momentarily 429s, an already-paid
 * winner nets open again and flashes back as a "Claim" card. The order log alone cannot
 * settle the question reliably, so for a settled winner we ask the chain directly.
 *
 * `expiry_market::order_value(market, Option<Pricer>, order_id): u64` returns the DUSDC
 * (base units) an order is still worth. Verified live 2026-08-18 against the 8-06 package:
 * a FULLY-REDEEMED order returns 0; a still-open order returns a positive value. Within the
 * set we apply this to (settled WINNERS the fold is about to render as claimable), a 0 can
 * only mean "already redeemed", because an unredeemed winner is always worth more than zero
 * and losers never render as claim cards. So value == 0 ⇒ drop it.
 *
 * We pass Option::None for the Pricer: a settled market prices off its stored settlement,
 * no live Pricer needed. All the order_value calls are batched into ONE simulate, so a
 * whole portfolio of winners costs a single read.
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config, v2Target } from '@/config/predict';
import { SIM_SENDER, simulate, type SimulateCapableClient } from './account';

/** `Option<Pricer>` type-arg for `option::none` — the settled read needs no live pricer. */
const PRICER_TYPE = () => `${predictV2Config.packages.predict}::pricing::Pricer`;

/** Sanity bound on one batched simulate (a normal trader holds a handful of settled
 *  winners at once; this only guards a pathological list from one huge tx). */
const MAX_BATCH = 30;

export interface OrderValueEntry {
  marketId: string;
  orderId: bigint;
}

/**
 * The remaining on-chain value (DUSDC base units) of each settled order, keyed by
 * orderId.toString(). Missing from the map = we couldn't read it (fail-open: the caller
 * should NOT treat an absent entry as redeemed). A present value of 0n = fully redeemed.
 */
export async function readSettledOrderValues(
  client: SimulateCapableClient,
  entries: OrderValueEntry[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const batch = entries.slice(0, MAX_BATCH);
  if (batch.length === 0) return out;

  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  for (const e of batch) {
    // Each order_value consumes its own Option::None (passed by value), so one none per call.
    const none = tx.moveCall({ target: '0x1::option::none', typeArguments: [PRICER_TYPE()] });
    tx.moveCall({
      target: v2Target('expiry_market', 'order_value'),
      arguments: [tx.object(e.marketId), none, tx.pure.u256(e.orderId)],
    });
  }

  let res;
  try {
    res = await simulate(client, tx);
  } catch {
    return out; // transport failure → fail-open (no entries, so nothing is dropped)
  }
  const cmds = res.commandResults ?? [];
  // Commands interleave none(2k), order_value(2k+1); read each order_value's return.
  batch.forEach((e, k) => {
    const rv = cmds[2 * k + 1]?.returnValues?.[0]?.bcs;
    if (!rv) return;
    try {
      out.set(e.orderId.toString(), BigInt(bcs.u64().parse(new Uint8Array(rv))));
    } catch {
      /* leave it absent → fail-open for this entry */
    }
  });
  return out;
}
