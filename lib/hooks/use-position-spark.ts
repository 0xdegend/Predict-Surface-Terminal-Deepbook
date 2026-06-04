'use client';

/**
 * A real implied-probability path for a single binary position over its holding
 * window: the oracle's forward history priced through its SVI history at this
 * position's strike. Because a binary's price IS its probability, this series
 * is the position's value path — an honest sparkline, not a synthetic curve.
 *
 * Keyed by oracle (+ strike + side) so TanStack dedupes across positions that
 * share an oracle. Falls back to the full window if the holding window is thin.
 */
import { useQuery } from '@tanstack/react-query';
import { getPriceHistory, getSviHistory } from '@/lib/api/client';
import { toFloat } from '@/config/scale';
import { parseSvi, upFair, dnFair } from '@/lib/svi/svi';
import type { PositionSummary } from '@/lib/api/types';

const LIMIT = 90;

export function usePositionSpark(p: PositionSummary): number[] {
  const strike = toFloat(p.strike);
  const q = useQuery({
    queryKey: ['position-spark', p.oracle_id, p.strike, p.is_up],
    queryFn: async (): Promise<number[]> => {
      const [prices, svis] = await Promise.all([
        getPriceHistory(p.oracle_id, LIMIT),
        getSviHistory(p.oracle_id, LIMIT),
      ]);
      if (prices.length === 0 || svis.length === 0) return [];

      // Server returns newest-first; walk oldest → newest.
      const px = [...prices].sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms);
      const sv = [...svis].sort((a, b) => a.checkpoint_timestamp_ms - b.checkpoint_timestamp_ms);

      let si = 0;
      const full = px.map((e) => {
        const t = e.checkpoint_timestamp_ms;
        // advance to the latest SVI snapshot at/just before this price point
        while (si + 1 < sv.length && sv[si + 1].checkpoint_timestamp_ms <= t) si++;
        const svi = parseSvi(sv[si]);
        const fwd = toFloat(e.forward);
        const fair = p.is_up ? upFair(strike, fwd, svi) : dnFair(strike, fwd, svi);
        return { t, v: fair };
      });

      const held = full.filter((d) => d.t >= (p.first_minted_at || 0)).map((d) => d.v);
      return held.length >= 4 ? held : full.map((d) => d.v);
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  return q.data ?? [];
}
