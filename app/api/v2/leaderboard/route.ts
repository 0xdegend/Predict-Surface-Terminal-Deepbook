import { NextResponse } from 'next/server';
import { ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { getLeaderboardBoards } from '@/lib/leaderboard/v2-indexer';
import { getSkewLeaderboardSnapshot } from '@/lib/leaderboard/v2-onchain-store';

/**
 * GET /api/v2/leaderboard — both Season-2 boards: `{ all, skew, builtAtMs }`.
 *
 * 7-29: served from the persistent ACCUMULATING indexer (lib/leaderboard/v2-indexer),
 * which folds new trades into a KV-persisted tally so history is complete and never
 * re-truncated by a windowed scan (a high-frequency bot can no longer bury real
 * traders). 6-24: its HTTP indexer still serves the venue board client-side, so `all`
 * is empty here and only the on-chain Skew snapshot is returned.
 *
 * `nodejs` runtime for fetch + the module-level tally; `force-dynamic` + no-store so a
 * fresh board is served each request (the indexer/cache does its own TTL de-duping).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (ACTIVE_V2_DEPLOYMENT === '7-29') {
    const boards = await getLeaderboardBoards();
    return NextResponse.json(boards, { headers: { 'cache-control': 'no-store' } });
  }
  const snap = await getSkewLeaderboardSnapshot();
  return NextResponse.json(
    { all: [], skew: snap.rows, builtAtMs: snap.builtAtMs },
    { headers: { 'cache-control': 'no-store' } },
  );
}
