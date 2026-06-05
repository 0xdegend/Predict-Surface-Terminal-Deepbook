/**
 * keeper/src/server.mjs — thin typed-ish client for the Predict public server.
 * Only the endpoints the keeper needs. Mirrors the app's lib/api/client.ts.
 */

export function makeServer(cfg) {
  const get = async (path) => {
    const res = await fetch(`${cfg.serverUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  };
  return {
    /** All oracles for the configured predict object. */
    getOracles: () => get(`/predicts/${cfg.predictObjectId}/oracles`),
    /** Global mint events (used to find managers active on settled oracles). */
    getPositionsMinted: (limit = 3000) => get(`/positions/minted?limit=${limit}`),
    /** A manager's full position list (status + open_quantity per key). */
    getManagerPositions: (managerId) => get(`/managers/${managerId}/positions/summary`),
  };
}

/** Run async `fn` over `items` with a bounded worker pool. Errors per item are swallowed. */
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
