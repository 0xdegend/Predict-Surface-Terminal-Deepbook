/**
 * keeper/v2/scan.mjs — PURE candidate detection for the v2 keeper. No network/SDK.
 *
 * v2 positions are strike RANGES (lower_tick, higher_tick]; price = tick × tick_size
 * (1e9-scaled). Sentinels: lower_tick 0 = −∞, higher_tick POS_INF_TICK = +∞. A
 * position is in-the-money at settlement iff the settlement price falls in the
 * range — so UP=(strike,+∞) wins when settlement>strike and DOWN=(0,strike) wins
 * when settlement≤strike, all from one rule:
 *   wins ⟺ settlement > lower_price  AND  settlement ≤ higher_price
 */
import { POS_INF_TICK } from './config.mjs';

/** Build marketId → { settlementPrice, tickSize } from /markets/:id/state rows. */
export function settledMarketMap(states) {
  const m = new Map();
  for (const s of states) {
    if (!s || !s.settlement) continue;
    const price = s.settlement.settlement_price ?? s.settlement.price ?? s.settlement.settlementPrice;
    if (price == null) continue;
    m.set(s.expiry_market_id, {
      settlementPrice: BigInt(price),
      tickSize: BigInt(s.market?.tick_size ?? 0),
    });
  }
  return m;
}

/** True if a range order is in-the-money at `settlementScaled` (1e9-scaled). */
export function orderWins(order, settlementScaled, tickSizeScaled) {
  const aboveLower = order.lowerTick === 0n ? true : settlementScaled > order.lowerTick * tickSizeScaled;
  const atOrBelowHigher =
    order.higherTick === POS_INF_TICK ? true : settlementScaled <= order.higherTick * tickSizeScaled;
  return aboveLower && atOrBelowHigher;
}

/**
 * Redeemable candidates among a settled market's orders: open quantity > 0 and
 * in-the-money (losers pay nothing, so claiming them only burns gas).
 */
export function redeemCandidates(marketId, orders, settled) {
  const out = [];
  for (const o of orders) {
    if (!(o.quantity > 0n)) continue;
    if (!orderWins(o, settled.settlementPrice, settled.tickSize)) continue;
    out.push({ marketId, orderId: o.orderId, wrapperId: o.wrapperId, closeQuantity: o.quantity });
  }
  return out;
}

/** Leveraged, still-open orders on a live market — liquidation candidates to probe. */
export function liquidationCandidates(marketId, orders) {
  return orders
    .filter((o) => o.isLeveraged && o.quantity > 0n)
    .map((o) => ({ marketId, orderId: o.orderId }));
}

export const candidateKey = (c) => `${c.marketId}:${c.orderId}`;
