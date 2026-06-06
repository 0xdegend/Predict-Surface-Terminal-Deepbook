'use client';

/**
 * useLeaderboard — the trader leaderboard data spine.
 *
 * Single cheap fetch: the global minted/redeemed event streams + the manager
 * list → scored per-owner rows (volume, activity, and the Points score). No
 * per-manager fan-out, so the board is complete for every trader and never trips
 * the public server's rate limit. Authoritative win rate / PnL live on each
 * trader's Portfolio, not here.
 *
 * Server-data only (no wallet), so it renders for any visitor.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getManagers, getPositionsMinted, getPositionsRedeemed, qk } from '@/lib/api/client';
import { aggregateLeaderboard, type LeaderboardRow } from '@/lib/leaderboard/aggregate';

/** Event-window depth pulled for the board. */
const EVENT_LIMIT = 2000;

export interface UseLeaderboard {
  rows: LeaderboardRow[];
  loading: boolean;
  /** True during a background refetch (drives the refresh-button spinner). */
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
}

export function useLeaderboard(): UseLeaderboard {
  const q = useQuery({
    queryKey: qk.leaderboardBase,
    queryFn: async () => {
      const [managers, minted, redeemed] = await Promise.all([
        getManagers(5000),
        getPositionsMinted(EVENT_LIMIT),
        getPositionsRedeemed(EVENT_LIMIT),
      ]);
      return aggregateLeaderboard(minted, redeemed, managers, Date.now());
    },
    staleTime: 30_000,
  });

  const rows = useMemo(() => q.data ?? [], [q.data]);

  return {
    rows,
    loading: q.isLoading,
    refreshing: q.isFetching,
    error: q.error instanceof Error ? q.error.message : null,
    refetch: () => q.refetch(),
  };
}
