import { NextResponse } from 'next/server';
import { V2_IS_729_PLUS } from '@/config/predict';
import { getLeaderboardBoards } from '@/lib/leaderboard/v2-indexer';
import { getSkewLeaderboardSnapshot } from '@/lib/leaderboard/v2-onchain-store';
import { mergeLegacyCarryover } from '@/lib/leaderboard/legacy-carryover';

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
  if (V2_IS_729_PLUS) {
    const boards = await getLeaderboardBoards();
    // Overlay the carried-over 6-24 Skew points as a baseline; live 8-06 trading keeps
    // accumulating on top. Only the Skew board carries over (the `all` venue board stays
    // pure live data). See lib/leaderboard/legacy-carryover.
    return NextResponse.json(
      { ...boards, skew: mergeLegacyCarryover(boards.skew) },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const snap = await getSkewLeaderboardSnapshot();
  return NextResponse.json(
    { all: [], skew: snap.rows, builtAtMs: snap.builtAtMs },
    { headers: { 'cache-control': 'no-store' } },
  );
}
