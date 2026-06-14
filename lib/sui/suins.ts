/**
 * lib/sui/suins.ts — SuiNS reverse resolution (address → default name).
 *
 * Uses the gRPC core client's `defaultNameServiceName` (no extra dependency).
 * Names rarely change, so callers cache hard. We funnel all lookups through a
 * small concurrency limiter so a leaderboard page doesn't fire 30 RPCs at once.
 */

/** Minimal core-client shape we use (cast — the SDK result types are generic). */
interface NameServiceClient {
  defaultNameServiceName: (opts: { address: string }) => Promise<{ data: { name: string | null } }>;
}

const MAX_CONCURRENT = 6;
let active = 0;
const waiters: (() => void)[] = [];

async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/**
 * Resolve an address's default SuiNS name (e.g. `alice.sui`), or null if it has
 * none. Never throws — a resolution failure just falls back to null so the UI
 * shows the truncated address.
 */
export async function resolveDefaultName(core: unknown, address: string): Promise<string | null> {
  const client = core as NameServiceClient;
  return withLimit(async () => {
    try {
      return (await client.defaultNameServiceName({ address })).data?.name ?? null;
    } catch {
      return null;
    }
  });
}
