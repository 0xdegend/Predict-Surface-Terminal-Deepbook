import { NextResponse } from 'next/server';
import { getSkewLeaderboardSnapshot } from '@/lib/leaderboard/v2-onchain-store';

/**
 * GET /api/v2/leaderboard — the all-time Skew leaderboard.
 *
 * Built from a server-side GraphQL scan of the chain's order events (see
 * lib/leaderboard/v2-onchain-*), never from the browser. `nodejs` runtime for fetch +
 * the module-level cache; `force-dynamic` + no-store so a fresh board is served on
 * every request (the cache itself does the TTL de-duping).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const snap = await getSkewLeaderboardSnapshot();
  return NextResponse.json(snap, { headers: { 'cache-control': 'no-store' } });
}
