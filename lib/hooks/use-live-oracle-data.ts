'use client';

/**
 * Live active-oracle set + their current SmileInputs, polled from the server so
 * newly opened expiries appear and settled ones drop out without a page reload.
 *
 * Seeded from the server snapshot (no empty first paint). Deduped by query key,
 * so the oracle table and the trade ticket share one poll and always agree on
 * what's tradeable — clicking a freshly-opened market in the table loads cleanly
 * in the ticket.
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getOracles, getOracleState } from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { parseSvi } from '@/lib/svi/svi';
import type { Oracle } from '@/lib/api/types';
import type { SmileInput } from '@/lib/svi/surface';

const REFETCH_MS = 20_000;

export function useLiveOracleData(
  initialOracles: Oracle[],
  initialInputs: SmileInput[],
): { oracles: Oracle[]; inputs: SmileInput[] } {
  const oraclesQ = useQuery({
    queryKey: ['live', 'active-oracles'],
    queryFn: async () => {
      const all = await getOracles();
      return all.filter((o) => o.status === 'active').sort((a, b) => a.expiry - b.expiry);
    },
    initialData: initialOracles,
    refetchInterval: REFETCH_MS,
  });
  const oracles = oraclesQ.data;
  const ids = oracles.map((o) => o.oracle_id).join(',');

  const inputsQ = useQuery({
    queryKey: ['live', 'oracle-inputs', ids],
    queryFn: async (): Promise<SmileInput[]> => {
      const states = await Promise.all(oracles.map((o) => getOracleState(o.oracle_id)));
      return states.flatMap((st, i) => {
        if (!st.latest_svi || !st.latest_price) return [];
        const o = oracles[i];
        return [
          {
            oracle: o,
            svi: parseSvi(st.latest_svi),
            forward: toFloat(st.latest_price.forward),
            settlement: o.settlement_price != null ? toFloat(o.settlement_price) : null,
          },
        ];
      });
    },
    enabled: oracles.length > 0,
    placeholderData: keepPreviousData, // keep current rows while a new set loads
    refetchInterval: REFETCH_MS,
  });

  return { oracles, inputs: inputsQ.data ?? initialInputs };
}
