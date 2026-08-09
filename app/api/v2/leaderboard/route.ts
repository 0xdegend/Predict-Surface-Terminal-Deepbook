import { NextResponse } from 'next/server';
import { V2_IS_729_PLUS } from '@/config/predict';
import { getLeaderboardBoards } from '@/lib/leaderboard/v2-indexer';
import { getSkewLeaderboardSnapshot } from '@/lib/leaderboard/v2-onchain-store';
import { mergeLegacyCarryover } from '@/lib/leaderboard/legacy-carryover';
import { mergeFaucetParticipants } from '@/lib/leaderboard/faucet-participants';
import { listFaucetClaimers } from '@/lib/server/grant-store';
import type { V2LeaderboardRow } from '@/lib/leaderboard/v2';

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

/**
 * Fold the starter-grant faucet claimers into a Skew board: a wallet that onboarded
 * through Skew shows on the board even before it trades (0-trade rows are badged
 * "Starter" in the UI). The faucet ledger is keyed by address, so this is cumulative
 * across deployments (6-24 / 7-29 / 8-06) and only ever touches the Skew board — the
 * `all` venue board stays pure live data. Never throws — a store hiccup just yields the
 * board unchanged. Legacy 6-24 carryover is applied by the caller BEFORE this, and only
 * on 729-plus (overlaying the 6-24 seed on 6-24's own board would double-count).
 */
async function addFaucetParticipants(skew: V2LeaderboardRow[]): Promise<V2LeaderboardRow[]> {
  const claimers = await listFaucetClaimers().catch(() => [] as string[]);
  return mergeFaucetParticipants(skew, claimers);
}

export async function GET() {
  if (V2_IS_729_PLUS) {
    const boards = await getLeaderboardBoards();
    // Carry the 6-24 points forward, THEN fold in the faucet onboards.
    return NextResponse.json(
      { ...boards, skew: await addFaucetParticipants(mergeLegacyCarryover(boards.skew)) },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const snap = await getSkewLeaderboardSnapshot();
  return NextResponse.json(
    { all: [], skew: await addFaucetParticipants(snap.rows), builtAtMs: snap.builtAtMs },
    { headers: { 'cache-control': 'no-store' } },
  );
}
