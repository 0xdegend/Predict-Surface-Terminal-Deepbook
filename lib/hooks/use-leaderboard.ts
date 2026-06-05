'use client';

/**
 * useLeaderboard — the trader leaderboard data spine. Two-stage (see
 * lib/leaderboard/aggregate.ts for the why):
 *
 *   Stage 1: one fetch each of the global minted/redeemed streams + the manager
 *     list → volume & activity rows. Complete and accurate within the window.
 *   Stage 2: fetch authoritative PnL summaries for the managers of the top
 *     `ENRICH_OWNERS` rows (bounded concurrency) and fold them in. PnL ranks
 *     among the most active accounts; the methodology is shown in the UI.
 *
 * Everything is server-data only (no wallet), so it works for any visitor.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getManagers,
  getManagerSummary,
  getPositionsMinted,
  getPositionsRedeemed,
  qk,
} from '@/lib/api/client';
import {
  aggregateLeaderboard,
  attachPnl,
  type LeaderboardRow,
} from '@/lib/leaderboard/aggregate';
import type { ManagerSummary } from '@/lib/api/types';

/** Event-window depth pulled for the volume/activity board. */
const EVENT_LIMIT = 2000;
/** How many top-by-volume owners get authoritative PnL enrichment. */
export const ENRICH_OWNERS = 60;
/** Parallel manager-summary fetches (politeness to the public server). */
const CONCURRENCY = 8;

/** Fetch many manager summaries with a bounded worker pool. Failures are skipped. */
async function fetchSummaries(ids: string[]): Promise<Map<string, ManagerSummary>> {
  const out = new Map<string, ManagerSummary>();
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        out.set(id, await getManagerSummary(id));
      } catch {
        /* skip — a missing summary just leaves that row PnL-less */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return out;
}

export interface UseLeaderboard {
  rows: LeaderboardRow[];
  baseLoading: boolean;
  pnlLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useLeaderboard(): UseLeaderboard {
  const baseQ = useQuery({
    queryKey: qk.leaderboardBase,
    queryFn: async () => {
      const [managers, minted, redeemed] = await Promise.all([
        getManagers(5000),
        getPositionsMinted(EVENT_LIMIT),
        getPositionsRedeemed(EVENT_LIMIT),
      ]);
      return aggregateLeaderboard(minted, redeemed, managers);
    },
    staleTime: 30_000,
  });

  const base = useMemo(() => baseQ.data ?? [], [baseQ.data]);

  // Manager ids of the top contenders → the stage-2 enrichment set.
  const enrichIds = useMemo(
    () => base.slice(0, ENRICH_OWNERS).flatMap((r) => r.managerIds),
    [base],
  );
  const idKey = enrichIds.join(',');

  const pnlQ = useQuery({
    queryKey: qk.leaderboardPnl(idKey),
    queryFn: () => fetchSummaries(enrichIds),
    enabled: enrichIds.length > 0,
    staleTime: 30_000,
  });

  const rows = useMemo(
    () => (pnlQ.data ? attachPnl(base, pnlQ.data) : base),
    [base, pnlQ.data],
  );

  return {
    rows,
    baseLoading: baseQ.isLoading,
    pnlLoading: pnlQ.isFetching,
    error: baseQ.error instanceof Error ? baseQ.error.message : null,
    refetch: () => {
      baseQ.refetch();
      pnlQ.refetch();
    },
  };
}
