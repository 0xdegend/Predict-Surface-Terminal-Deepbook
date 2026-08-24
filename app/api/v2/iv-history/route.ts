import { NextResponse } from 'next/server';
import { getV2Markets } from '@/lib/api/v2/client';
import { activeMarkets } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient } from '@/lib/sui/v2/pricer';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { constantMaturityAtmIv, CONSTANT_TENOR_HOURS, type AtmPoint, type IvSample } from '@/lib/insights/iv-history';
import { readSeries, recordSample } from '@/lib/server/iv-store';

/**
 * GET /api/v2/iv-history — the accumulating constant-maturity ATM implied-vol series.
 *
 * Returns `{ samples, current, tenorHours, recorded }`. `samples` is the history the
 * page ranks today's reading against; `current` is the reading just taken.
 *
 * WHY THE SERVER TAKES THE SAMPLE. The client already computes ATM IV for every live
 * expiry, so it would be cheaper to have the page post its own number. That would also
 * make the series trivially poisonable by anyone with curl, and this history is the
 * one thing on the page that cannot be re-derived if it goes wrong: there is no SVI
 * history endpoint to rebuild it from. So the sample is read here, from the chain, via
 * the same `load_live_pricer` simulation the app quotes off.
 *
 * CONSTANT MATURITY. Sampling the front market would produce a series that mostly
 * tracks time-to-expiry rather than the market, so the reading is interpolated to a
 * fixed tenor across every live expiry. See lib/insights/iv-history.
 *
 * Never fails the page: if the chain read does not work, the stored series is returned
 * with `current: null` and the panel simply shows history without a live mark.
 *
 * `nodejs` runtime for the gRPC client and the module-level cache. `force-dynamic`
 * because the response mutates the series; the short CDN cache keeps the simulate
 * fan-out down to a couple of runs a minute under load.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Shared for everyone (the series is global), refreshed a couple of times a minute. */
const CACHE = 'public, s-maxage=30, stale-while-revalidate=300';

/** Simulating every live expiry is the cost here, so cap the fan-out. Sorted by
 *  expiry first, so the ones that actually bracket the target tenor are kept. */
const MAX_EXPIRIES = 6;

export interface IvHistoryResponse {
  samples: IvSample[];
  /** The reading taken on this request, or null when the chain read failed. */
  current: number | null;
  tenorHours: number;
  /** True when this request appended a new sample. */
  recorded: boolean;
}

/** ATM vol for each live expiry, from the chain. Skips any market that will not price. */
async function readAtmPoints(now: number): Promise<AtmPoint[]> {
  const all = await getV2Markets(60);
  const live = activeMarkets(all, now)
    .slice()
    .sort((a, b) => a.expiry - b.expiry)
    .slice(0, MAX_EXPIRIES);
  if (live.length === 0) return [];

  const client = v2GrpcClient();
  const settled = await Promise.allSettled(
    live.map(async (m) => {
      const p = await simulateLivePricer(client, m.expiry_market_id);
      const tYears = timeToExpiryYears(m.expiry, now);
      if (!(tYears > 0)) return null;
      // At the money means at the FORWARD, which is where k = 0 on this smile.
      const atmIv = impliedVol(p.forward, p.forward, p.svi, tYears);
      return Number.isFinite(atmIv) && atmIv > 0 ? { tYears, atmIv } : null;
    }),
  );

  return settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

export async function GET() {
  const now = Date.now();

  let current: number | null = null;
  try {
    const points = await readAtmPoints(now);
    current = constantMaturityAtmIv(points);
  } catch {
    /* Chain read failed. Serve the history we have rather than erroring the panel. */
  }

  const { samples, recorded } =
    current != null ? await recordSample(current, now) : { samples: await readSeries(now), recorded: false };

  const body: IvHistoryResponse = { samples, current, tenorHours: CONSTANT_TENOR_HOURS, recorded };
  return NextResponse.json(body, { headers: { 'Cache-Control': CACHE } });
}
