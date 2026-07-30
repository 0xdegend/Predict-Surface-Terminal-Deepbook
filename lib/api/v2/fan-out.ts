/**
 * lib/api/v2/fan-out.ts — helpers for fanning the per-market feeds out across the
 * retained market roster. The beta indexer has no global order stream, so both the
 * leaderboard and the Trader-styles roster reconstruct their view by pulling
 * `/markets/:id/orders` for every retained market. These bound that fan-out (a
 * limited number in flight) and harden it against the indexer occasionally
 * dropping a request under the load.
 *
 * Pure + framework-agnostic, so they run in a client queryFn OR a server route.
 */

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/**
 * Retry a fetch a few times before giving up. The beta indexer occasionally drops
 * a request under the fan-out; without this a single transient failure silently
 * evicts that market's orders for the whole cycle.
 */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw err;
}
