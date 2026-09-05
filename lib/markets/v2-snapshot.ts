/**
 * lib/markets/v2-snapshot.ts — the live snapshot a Kelly page renders from.
 *
 * Active markets plus warm pricers for the nearest two per cadence, so the surface, the
 * ticket and Autopilot's engine all paint with real numbers on the first frame. The chat
 * and Autopilot pages each fetched exactly this on their own; the hub renders both from
 * one fetch. Server-side only (it simulates against the gRPC fullnode).
 */
import { getV2Markets, getV2Status } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, CADENCE_ORDER, wallClockMs } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, type LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';

export interface V2Snapshot {
  markets: V2Market[];
  /** Server wall clock (ms), from the indexer when it answered. */
  now: number;
  pricerSeeds: Record<string, LivePricer>;
}

export type V2SnapshotResult = { ok: true; snapshot: V2Snapshot } | { ok: false; error: string };

/** How many of the soonest markets per cadence get a warm pricer (two make a surface). */
const SEEDS_PER_CADENCE = 2;

export async function loadV2Snapshot(): Promise<V2SnapshotResult> {
  let markets: V2Market[];
  let now = wallClockMs();
  try {
    const [rows, status] = await Promise.all([getV2Markets(100), getV2Status().catch(() => null)]);
    now = status?.current_time_ms ?? now;
    markets = activeMarkets(rows, now);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const grouped = groupByCadence(markets);
  const targets = CADENCE_ORDER.flatMap((c) => grouped[c].slice(0, SEEDS_PER_CADENCE)) as V2Market[];
  const client = v2GrpcClient();
  const results = await Promise.allSettled(targets.map((m) => simulateLivePricer(client, m.expiry_market_id)));
  const pricerSeeds: Record<string, LivePricer> = {};
  targets.forEach((m, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') pricerSeeds[m.expiry_market_id] = r.value;
  });
  return { ok: true, snapshot: { markets, now, pricerSeeds } };
}
