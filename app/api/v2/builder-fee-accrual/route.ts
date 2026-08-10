import { NextResponse } from 'next/server';
import { predictV2Config } from '@/config/predict';
import { onchainBuilderFeeAccrual } from '@/lib/api/v2/onchain';

/**
 * GET /api/v2/builder-fee-accrual — the per-trade builder-fee ACCRUAL timeline for the
 * app's configured code: `{ events: [{ ts, fee }] }`, ascending, `fee` in DUSDC.
 *
 * The admin earnings chart used to plot the CLAIM log (a few sweep events), so a
 * cumulative line drew a straight ramp that implied constant earning. This is the real
 * cadence — every attributed trade's exact `builder_fee` at its own timestamp — so the
 * curve is flat while quiet and steep while busy. Reconstructed on the server (a small
 * fan-out over the code's attributed accounts) and cached at the edge, since the data
 * is global and identical for every viewer.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Global + viewer-independent, so it's safe to share from the CDN edge: cache 60s and
// serve a slightly-stale copy for 5 more minutes while one background request refreshes.
const CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

export async function GET() {
  try {
    const events = await onchainBuilderFeeAccrual(predictV2Config.builderCodeId);
    return NextResponse.json({ events }, { headers: { 'cache-control': CACHE } });
  } catch {
    // Never blank the chart on a read hiccup — the client falls back to the claim log.
    return NextResponse.json({ events: [] }, { headers: { 'cache-control': CACHE } });
  }
}
