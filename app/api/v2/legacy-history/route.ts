/**
 * /api/v2/legacy-history — a wallet's carried-over trade history from retired deployments.
 *
 * Exists so the snapshots stay OFF the client bundle. They are ~960 KB together and grow
 * with every release, while any one visitor needs only the rows for their own wallet — a
 * few KB. Importing them into the history hook, as the 53 KB 6-24 seed used to be, would
 * make every page load carry every trader's history.
 *
 * `?owner=0x…` returns that wallet's rows. `?all=1` returns the full map, which the admin
 * console needs for win-rate and join-curve stats.
 */
import { NextResponse } from 'next/server';
import { legacyHistoryFor, legacyHistoryByOwner, LEGACY_HISTORY_SOURCE } from '@/lib/portfolio/legacy-history-data';

/** The snapshots are static files compiled into the server bundle, so this response only
 *  changes when we ship a new seed. Cache it hard rather than re-serializing per request. */
const CACHE = 'public, max-age=300, stale-while-revalidate=86400';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  if (params.get('all') === '1') {
    return NextResponse.json(
      { source: LEGACY_HISTORY_SOURCE, byOwner: legacyHistoryByOwner() },
      { headers: { 'cache-control': CACHE } },
    );
  }

  const owner = params.get('owner');
  // No owner is not an error: a disconnected visitor legitimately has nothing to carry,
  // and the history hook calls this before a wallet is connected.
  const rows = owner ? legacyHistoryFor(owner) : [];
  return NextResponse.json({ source: LEGACY_HISTORY_SOURCE, rows }, { headers: { 'cache-control': CACHE } });
}
