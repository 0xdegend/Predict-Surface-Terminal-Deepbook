/**
 * keeper/v2/server.mjs — beta indexer client for the keeper.
 *
 * Markets + market state are live. Per-market ORDER discovery works via
 * `/markets/{id}/orders` (200, verified 2026-06-27 — currently returns [] on
 * testnet since there are no open orders). The global /orders, /market-orders,
 * /managers names 404. getOrdersForMarket probes the working name first and falls
 * back gracefully. NOTE: the order ROW field names below are best-effort — adjust
 * normalizeOrder once a populated response is observed.
 */
export function makeServer(cfg) {
  const get = async (base, path) => {
    const res = await fetch(`${base}${path}`);
    if (res.status === 404) return { __notFound: true };
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  };

  let ordersAvailable = null; // cached probe result

  return {
    getMarkets: (limit = 100) => get(cfg.serverUrl, `/markets?limit=${limit}`),
    getMarketState: (id) => get(cfg.serverUrl, `/markets/${id}/state`),

    /**
     * Open orders on a market: { orderId, wrapperId, lowerTick, higherTick,
     * quantity, isLeveraged }. Returns { available, orders }. Probes a few
     * candidate endpoint names once; all 404 today → available:false.
     */
    async getOrdersForMarket(marketId) {
      const candidates = [
        `/markets/${marketId}/orders`,
        `/market-orders?market=${marketId}`,
        `/orders?market=${marketId}`,
      ];
      for (const path of candidates) {
        const r = await get(cfg.serverUrl, path);
        if (!r.__notFound && Array.isArray(r)) {
          ordersAvailable = true;
          return { available: true, orders: r.map(normalizeOrder) };
        }
      }
      ordersAvailable = false;
      return { available: false, orders: [] };
    },

    ordersEndpointKnown: () => ordersAvailable,
  };
}

/** Map a raw indexer order row to the keeper's shape (best-effort field names). */
function normalizeOrder(o) {
  return {
    orderId: BigInt(o.order_id ?? o.id ?? 0),
    wrapperId: o.wrapper_id ?? o.account_wrapper_id ?? o.wrapper,
    lowerTick: BigInt(o.lower_tick ?? 0),
    higherTick: BigInt(o.higher_tick ?? 0),
    quantity: BigInt(o.open_quantity ?? o.quantity ?? 0),
    isLeveraged: Boolean(o.is_leveraged ?? (o.floor_shares ? Number(o.floor_shares) > 0 : false)),
  };
}

/** Bounded worker pool; per-item errors are swallowed. */
export async function mapPool(items, concurrency, fn) {
  const out = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
