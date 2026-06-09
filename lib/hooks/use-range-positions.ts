'use client';

/**
 * useRangePositions — the trader's vertical-range positions, derived client-side.
 *
 * The server has no open-range summary, so we fold the manager's /ranges event
 * streams into open positions (aggregateRangePositions) and value each one with
 * the live `rangeFair` from its oracle's latest SVI (settled oracles value at
 * 1/0). Quotes for the actual redeem stay chain-authoritative via quoteRange.
 */
import { useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { getManagerRanges, getOracleState, qk } from '@/lib/api/client';
import { aggregateRangePositions, valueRange, type RangePosition, type RangeValuation } from '@/lib/ranges/aggregate';
import { parseSvi, rangeFair, type SviFloat } from '@/lib/svi/svi';
import { toFloat } from '@/config/scale';

export interface ValuedRangePosition extends RangePosition, RangeValuation {
  underlying: string;
}

export function useRangePositions(managerId: string | null) {
  const rangesQ = useQuery({
    queryKey: qk.managerRanges(managerId ?? ''),
    queryFn: () => getManagerRanges(managerId!),
    enabled: !!managerId,
    refetchInterval: 8000,
  });

  const positions = useMemo(
    () => (rangesQ.data ? aggregateRangePositions(rangesQ.data.minted, rangesQ.data.redeemed) : []),
    [rangesQ.data],
  );

  // Fetch each distinct oracle once — for live valuation (open) and to resolve
  // the underlying for closed positions (which flow into trade history).
  const oracleIds = useMemo(
    () => [...new Set(positions.map((p) => p.oracleId))],
    [positions],
  );
  const stateQs = useQueries({
    queries: oracleIds.map((id) => ({
      queryKey: qk.oracleState(id),
      queryFn: () => getOracleState(id),
      staleTime: 5000,
      refetchInterval: 8000,
    })),
  });

  // Re-derive only when an oracle's data actually changes (its query's stamp).
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

  const valued: ValuedRangePosition[] = useMemo(
    () =>
      positions.map((p) => {
        const o = byOracle.get(p.oracleId);
        const fairUp = o
          ? rangeFair(toFloat(p.lowerStrike), toFloat(p.higherStrike), o.forward, o.svi, o.settlement)
          : 0;
        return { ...p, ...valueRange(p, fairUp), underlying: o?.underlying ?? '' };
      }),
    [positions, byOracle],
  );

  return {
    positions: valued,
    loading: rangesQ.isLoading,
    hasRanges: valued.length > 0,
  };
}
