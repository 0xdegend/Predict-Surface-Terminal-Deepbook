/**
 * order-value.ts — the on-chain "what is this order worth at settlement?" read, used as the
 * settled-LOSS backstop for the portfolio.
 *
 * `expiry_market::order_value(market, Option<Pricer>, order_id): u64` returns the DUSDC
 * (base units) an order is worth. On a SETTLED market that is its INTRINSIC settlement
 * payout, NOT its unredeemed balance: a LOSER reads 0, a WINNER reads its full payout
 * whether or not the keeper has already paid it out. (Correction to a 2026-08-18 note that
 * read "a FULLY-REDEEMED order returns 0" — that was validated against a loser; verified live
 * 2026-08-19 that a keeper-REDEEMED win, market 0x9b12…, still reads its full 16.71 payout.)
 *
 * So this read canNOT tell whether a WINNER has been redeemed — a paid win is dropped by
 * folding the keeper redeem event itself, matched by root (lib/api/v2/onchain.ts
 * scanMarketRedeems). What value == 0 DOES tell us, for a position we already know is settled,
 * is that it's a decided LOSS (worth nothing): there is nothing to claim, so it must not
 * linger as an open bet — it belongs in Trade History. See [[keeper-redeem-read-gap]].
 *
 * We pass Option::None for the Pricer: a settled market prices off its stored settlement, no
 * live Pricer needed. All the calls are batched into ONE simulate, so a whole portfolio of
 * settled positions costs a single read.
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
 * The intrinsic settlement value (DUSDC base units) of each settled order, keyed by
 * orderId.toString(). Missing from the map = we couldn't read it (fail-open: the caller must
 * NOT treat an absent entry as worthless). A present value of 0n = a settled LOSS (worth
 * nothing); a value > 0n = a win's payout (redeemed or not — this read can't distinguish).
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
