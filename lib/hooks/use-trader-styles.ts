'use client';

/**
 * useTraderStyles — classify the protocol's top traders for the analytics styles
 * tool. Takes the leaderboard's top owners by volume, fans out their managers
 * over `/positions/summary` (bounded — a few managers each, run on demand only
 * when the tool is open), classifies each, and rolls up a style distribution.
 *
 * Bounded by design (STYLE_TRADERS × MAX_MANAGERS queries) so it never trips the
 * public server. Range volume is omitted here to keep the fan-out small, so the
 * "Range trader" archetype is under-counted in the distribution vs an individual
 * profile (which does fetch ranges) — a deliberate cost trade-off.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getManagerPositions, qk } from '@/lib/api/client';
import { useLeaderboard } from '@/lib/hooks/use-leaderboard';
import { sortRows } from '@/lib/leaderboard/aggregate';
import {
  classifyStyle,
  ALL_ARCHETYPES,
  type TraderStyle,
  type StyleArchetype,
} from '@/lib/analytics/trader-style';
import type { PositionSummary } from '@/lib/api/types';

const STYLE_TRADERS = 18;
const MAX_MANAGERS = 2;

export interface ClassifiedTrader {
  owner: string;
  volume: number;
  style: TraderStyle;
}

export interface StyleBucket {
  id: StyleArchetype['id'];
  label: string;
  count: number;
}

export interface UseTraderStyles {
  traders: ClassifiedTrader[];
  distribution: StyleBucket[];
  loading: boolean;
  /** Owners we attempted to classify. */
  total: number;
}

export function useTraderStyles(): UseTraderStyles {
  const { rows, loading: lbLoading } = useLeaderboard();
  const top = useMemo(() => sortRows(rows, 'volume').slice(0, STYLE_TRADERS), [rows]);

  // Capped manager id list + a manager→owner map for regrouping the results.
  const { ids, ownerOf } = useMemo(() => {
    const ownerOf = new Map<string, string>();
    const ids: string[] = [];
    for (const r of top) {
      for (const m of r.managerIds.slice(0, MAX_MANAGERS)) {
        ids.push(m);
        ownerOf.set(m, r.owner);
      }
    }
    return { ids, ownerOf };
  }, [top]);

  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.managerPositions(id),
      queryFn: () => getManagerPositions(id),
      enabled: !!id,
      staleTime: 60_000,
    })),
  });
  const stamps = qs.map((q) => q.dataUpdatedAt).join(',');

  const { traders, distribution } = useMemo(() => {
    const byOwner = new Map<string, PositionSummary[]>();
    qs.forEach((q, i) => {
      const owner = ownerOf.get(ids[i]);
      if (!owner || !q.data) return;
      const arr = byOwner.get(owner) ?? [];
      arr.push(...q.data);
      byOwner.set(owner, arr);
    });

    const traders: ClassifiedTrader[] = [];
    for (const r of top) {
      const style = classifyStyle(byOwner.get(r.owner) ?? []);
      if (style.primary) traders.push({ owner: r.owner, volume: r.volume, style });
    }

    const counts = new Map<string, number>();
    for (const t of traders) counts.set(t.style.primary!.id, (counts.get(t.style.primary!.id) ?? 0) + 1);
    const distribution: StyleBucket[] = ALL_ARCHETYPES.map((a) => ({
      id: a.id,
      label: a.label,
      count: counts.get(a.id) ?? 0,
    }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count);

    return { traders, distribution };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamps, top]);

  const loading = lbLoading || qs.some((q) => q.isLoading);
  return { traders, distribution, loading, total: top.length };
}
