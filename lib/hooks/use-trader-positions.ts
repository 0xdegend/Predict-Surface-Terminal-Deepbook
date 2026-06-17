'use client';

/**
 * useTraderPositions — any trader's OPEN positions, read-only, for the
 * leaderboard "view positions" / copy-trade flow.
 *
 * Identical data sources to the logged-in user's account, just pointed at an
 * arbitrary set of managerIds (a leaderboard row carries every manager an owner
 * controls). Both `/managers/:id/positions/summary` and `/managers/:id/ranges`
 * are public and un-gated, so this needs no wallet and no new server surface.
 *
 *  - Binaries: server-valued — mark_price / mark_value / unrealized_pnl come
 *    straight from the positions summary, fanned out across the trader's managers.
 *  - Ranges: the server has no open-range summary, so we fold minted−redeemed by
 *    RangeKey and value each band off its oracle's latest SVI (mirrors
 *    useRangePositions, generalized to many managers).
 *
 * Only OPEN lots (open_quantity / openQty > 0) are returned — what a follower
 * could actually copy.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  getManagerPositions,
  getManagerRanges,
  getOracleState,
  humanizeApiError,
  qk,
} from '@/lib/api/client';
import { aggregateRangePositions, valueRange } from '@/lib/ranges/aggregate';
import { parseSvi, rangeFair, type SviFloat } from '@/lib/svi/svi';
import { toFloat } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';
import type { ValuedRangePosition } from './use-range-positions';

export interface UseTraderPositions {
  binary: PositionSummary[];
  ranges: ValuedRangePosition[];
  loading: boolean;
  /** Set only when *nothing* could be loaded (blocking). */
  error: string | null;
  /** Some managers loaded but others failed — show what we have + a note. */
  partial: boolean;
}

export function useTraderPositions(managerIds: string[], enabled = true): UseTraderPositions {
  const ids = useMemo(() => [...new Set(managerIds)], [managerIds]);

  /* ----------------------------- binaries ----------------------------- */
  const posQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.managerPositions(id),
      queryFn: () => getManagerPositions(id),
      enabled: enabled && !!id,
      staleTime: 5000,
      refetchInterval: 8000,
    })),
  });
  const posStamps = posQs.map((q) => q.dataUpdatedAt).join(',');
  const binary = useMemo(
    () => posQs.flatMap((q) => q.data ?? []).filter((p) => p.open_quantity > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [posStamps],
  );

  /* ------------------------------ ranges ------------------------------ */
  const rangeQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.managerRanges(id),
      queryFn: () => getManagerRanges(id),
      enabled: enabled && !!id,
      staleTime: 5000,
      refetchInterval: 8000,
    })),
  });
  const rangeStamps = rangeQs.map((q) => q.dataUpdatedAt).join(',');
  // Fold every manager's range streams into one owner-level set (same owner, so
  // matching by RangeKey across managers is correct for a net view).
  const rangePositions = useMemo(() => {
    const minted = rangeQs.flatMap((q) => q.data?.minted ?? []);
    const redeemed = rangeQs.flatMap((q) => q.data?.redeemed ?? []);
    return minted.length || redeemed.length ? aggregateRangePositions(minted, redeemed) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStamps]);

  // One oracle fetch per distinct oracle — for live range valuation.
  const oracleIds = useMemo(
    () => [...new Set(rangePositions.map((p) => p.oracleId))],
    [rangePositions],
  );
  const stateQs = useQueries({
    queries: oracleIds.map((id) => ({
      queryKey: qk.oracleState(id),
      queryFn: () => getOracleState(id),
      enabled: enabled && !!id,
      staleTime: 5000,
      refetchInterval: 8000,
    })),
  });
  const stateStamps = stateQs.map((q) => q.dataUpdatedAt).join(',');
  const byOracle = useMemo(() => {
    const m = new Map<string, { svi: SviFloat; forward: number; settlement: number | null; underlying: string }>();
    stateQs.forEach((q, i) => {
      const st = q.data;
      if (st?.latest_svi && st.latest_price) {
        m.set(oracleIds[i], {
          svi: parseSvi(st.latest_svi),
          forward: toFloat(st.latest_price.forward),
          settlement: st.oracle.settlement_price != null ? toFloat(st.oracle.settlement_price) : null,
          underlying: st.oracle.underlying_asset,
        });
      }
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateStamps, oracleIds]);

  const ranges: ValuedRangePosition[] = useMemo(
    () =>
      rangePositions
        .filter((p) => p.openQty > 0)
        .map((p) => {
          const o = byOracle.get(p.oracleId);
          const fairUp = o
            ? rangeFair(toFloat(p.lowerStrike), toFloat(p.higherStrike), o.forward, o.svi, o.settlement)
            : 0;
          return {
            ...p,
            ...valueRange(p, fairUp),
            underlying: o?.underlying ?? '',
            oracleSettled: o?.settlement != null,
          };
        }),
    [rangePositions, byOracle],
  );

  const allQs = [...posQs, ...rangeQs];
  const loading =
    enabled && ids.length > 0 && (posQs.some((q) => q.isLoading) || rangeQs.some((q) => q.isLoading));
  const firstErr = allQs.find((q) => q.error)?.error;
  // `binary`/`ranges` already skip a failed manager (flatMap of `data ?? []`), so
  // one manager's 500 just drops its lots. Only block the whole view when nothing
  // loaded at all; otherwise show what we have and flag it as partial.
  const anyLoaded = allQs.some((q) => q.data !== undefined);

  return {
    binary,
    ranges,
    loading,
    error: !loading && !anyLoaded && firstErr ? humanizeApiError(firstErr, "this trader's positions") : null,
    partial: anyLoaded && allQs.some((q) => q.error),
  };
}
