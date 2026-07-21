'use client';

/**
 * useV2Markets — keep the active-markets list LIVE after the server snapshot.
 *
 * The /v2 page server-fetches active markets once for instant first paint, but
 * the short cadences roll fast (a fresh 1-minute market opens every minute), so
 * a static list goes stale in seconds: new markets only appeared on reload and
 * the table could sit empty once everything expired. This hook polls /markets
 * and re-derives the active set, seeded from the server snapshot (initialData)
 * so there's no refetch flash on mount.
 *
 * Poll beats event-push here: MarketCreated rows come from the indexer anyway.
 *
 * Cadence matters: the pickers drop expired rows every second (`expiry > now`),
 * but this list only GROWS on the poll — so if the poll is slow the table keeps
 * shrinking between refills and looks starved until a reload (which fetches
 * immediately). Legacy gets away with a 20s poll only because its markets live
 * for hours; v2's roll every minute, so we poll fast AND refetch on focus so a
 * backgrounded tab refills the instant it's foregrounded (TanStack pauses the
 * interval while hidden) — the live list then behaves like a fresh reload.
 */
import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getV2Markets, qkV2 } from '@/lib/api/v2/client';
import { activeMarkets, recentMarkets } from '@/lib/markets/v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';

// Fast churn → fast poll: keep the refill window well under the per-tick expiry
// drop so the table never visibly starves (legacy's 20s suits its hours-long
// markets; v2's minute-long markets need this).
const POLL_MS = 4_000;

export function useV2Markets(initial: V2Market[]): V2Market[] {
  const { data } = useQuery({
    queryKey: qkV2.markets,
    queryFn: async () => activeMarkets(await getV2Markets(100)),
    initialData: initial,
    refetchInterval: POLL_MS,
    // Refetch the moment the tab regains focus (overrides the global
    // refetchOnWindowFocus: false) — returning to a backgrounded tab refills
    // immediately instead of showing a stale, starved list until a reload.
    refetchOnWindowFocus: true,
    // Keep the last good list on a transient server hiccup rather than
    // blanking the table (initialData already guarantees data is never
    // undefined, but a failed refetch shouldn't clear it either).
    placeholderData: keepPreviousData,
    retry: 1,
  });
  return data ?? initial;
}

/**
 * useV2RecentMarkets — the analytics window: active markets PLUS those that
 * expired within `lookbackMs`, newest-expiry-first, capped at `cap` to bound the
 * per-market fan-out. Lets the flow tape / recent-volume keep showing a fast
 * market's bets for a while after it settles (the market itself is gone from the
 * live `useV2Markets` list within a minute). Its own query key, so it doesn't
 * disturb the active-only list the pickers depend on.
 */
export function useV2RecentMarkets(initial: V2Market[], lookbackMs: number, cap: number): V2Market[] {
  const { data } = useQuery({
    queryKey: [...qkV2.markets, 'recent', lookbackMs] as const,
    queryFn: async () => recentMarkets(await getV2Markets(200), lookbackMs),
    initialData: initial,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  return useMemo(() => (data ?? initial).slice(0, cap), [data, initial, cap]);
}
