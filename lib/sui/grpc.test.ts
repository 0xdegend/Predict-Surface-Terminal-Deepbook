/**
 * Failover behaviour. These exercise the real module against real endpoints, with a
 * deliberately DEAD primary in front of the healthy one — the shape of the 2026-08-21
 * incident. Network-gated:
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/grpc.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

const RUN = process.env.RUN_LIVE === '1';
const d = RUN ? describe : describe.skip;

/** A host that accepts the connection and then never answers, like suiscan did. */
const DEAD = 'https://rpc-testnet.suiscan.xyz';
const HEALTHY = 'https://fullnode.testnet.sui.io:443';

d('grpcRead failover', () => {
  it('retries past a hung endpoint, inside the budget, and stays switched', async () => {
    process.env.NEXT_PUBLIC_SUI_GRPC_URL = `${DEAD},${HEALTHY}`;
    const { grpcRead, activeGrpcUrl } = await import('./grpc-core');
    const { predictV2Config } = await import('@/config/predict');

    expect(activeGrpcUrl(), 'starts on the dead primary').toBe(DEAD);

    const t0 = Date.now();
    const first = await grpcRead((c, signal) =>
      c.core.getObject({ objectId: predictV2Config.shared.poolVault, signal }),
    );
    const firstMs = Date.now() - t0;
    expect(first).toBeTruthy();
    // One timeout (5s) + one real read (<1s). The old behaviour was a 60s hang.
    expect(firstMs, `first read took ${firstMs}ms`).toBeLessThan(9_000);
    expect(activeGrpcUrl(), 'promoted the endpoint that answered').toBe(HEALTHY);

    // The dead node is now paid for ONCE, not on every read.
    const t1 = Date.now();
    await grpcRead((c, signal) =>
      c.core.getObject({ objectId: predictV2Config.shared.poolVault, signal }),
    );
    const secondMs = Date.now() - t1;
    expect(secondMs, `second read took ${secondMs}ms`).toBeLessThan(3_000);
    console.log(`first=${firstMs}ms (timeout + retry)   second=${secondMs}ms (promoted)   now=${activeGrpcUrl()}`);
  }, 60_000);

  it('gives up with a real error when every endpoint is dead', async () => {
    process.env.NEXT_PUBLIC_SUI_GRPC_URL = DEAD;
    process.env.NEXT_PUBLIC_SUI_GRPC_FALLBACK = DEAD;
    // A fresh module instance, so its CANDIDATES read the all-dead env above.
    vi.resetModules();
    const { grpcRead } = await import('./grpc-core');
    const { predictV2Config } = await import('@/config/predict');
    const t = Date.now();
    await expect(
      grpcRead((c, signal) => c.core.getObject({ objectId: predictV2Config.shared.poolVault, signal })),
    ).rejects.toThrow();
    const ms = Date.now() - t;
    console.log(`all-dead rejected in ${ms}ms`);
    expect(ms, 'must fail fast, not hang').toBeLessThan(20_000);
  }, 60_000);
});
