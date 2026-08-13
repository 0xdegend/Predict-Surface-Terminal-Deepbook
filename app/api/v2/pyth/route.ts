import { NextResponse } from 'next/server';
import { onchainPythLatest, onchainPythObservations } from '@/lib/api/v2/onchain';

/**
 * GET /api/v2/pyth?kind=latest | ?kind=history&limit=N — the BTC Pyth spot feed,
 * read on-chain SERVER-SIDE.
 *
 * WHY THIS EXISTS: the chart's live edge + the top spot tape read the Pyth feed
 * ~1-2x/s (latest via gRPC `getObject`, history via GraphQL `events`). Doing that from
 * the browser at that rate got Cloudflare-challenged on the old public proxies (nav
 * price blank, chart stuck on "Loading live chart"). Running the read here, server-side,
 * sidesteps it: the read stays same-origin from the browser's view, off the interactive
 * challenge path. Same pattern as /api/v2/leaderboard.
 *
 * `nodejs` runtime (the on-chain reader needs it) + `force-dynamic`; the cache-control
 * header still lets the CDN share one read across every viewer, so the origin does at
 * most ~1 read/s for `latest` no matter how many tabs are open.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// latest: the feed writes ~4x/s, so a 1s shared cache keeps it fresh while collapsing
// every tab's poll into one origin read. history: a ~90s window barely moves in 10s.
const LATEST_CACHE = 'public, s-maxage=1, stale-while-revalidate=4';
const HISTORY_CACHE = 'public, s-maxage=10, stale-while-revalidate=30';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? 'latest';
  try {
    if (kind === 'history') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 400);
      const obs = await onchainPythObservations(limit);
      return NextResponse.json(obs, { headers: { 'cache-control': HISTORY_CACHE } });
    }
    const obs = await onchainPythLatest();
    return NextResponse.json(obs, { headers: { 'cache-control': LATEST_CACHE } });
  } catch {
    // Surface a real failure so the client's query retries (its failsafe still lifts the
    // chart loader); never return an empty array, which would read as "history loaded,
    // nothing here" and strand the loader.
    return NextResponse.json({ error: 'pyth read failed' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
