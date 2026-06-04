'use client';

/**
 * The current "front" oracle — the soonest *non-expired* active market. The top
 * tape tracks this so it never freezes: the old behaviour pinned a single oracle
 * id at server-render time, so once that market settled its `/prices/latest`
 * stopped updating and the tape showed a stale spot/forward forever (looked
 * "late" vs the live oracle table).
 *
 * Shares the exact query key as `use-live-oracle-data`'s oracle list, so on the
 * surface page the two dedupe into one poll; on the portfolio/risk screens (no
 * table mounted) it runs standalone. `useNow(0)` keeps SSR/first-paint stable
 * (seed 0 ⇒ no expiry filtering until mounted), then advances each second.
 */
import { useQuery } from '@tanstack/react-query';
import { getOracles } from '@/lib/api/client';
import { useNow } from './use-now';
import type { Oracle } from '@/lib/api/types';

const REFETCH_MS = 20_000;

export function useFrontOracleId(fallbackId: string): string {
  const now = useNow(0);
  const { data } = useQuery({
    queryKey: ['live', 'active-oracles'],
    queryFn: async (): Promise<Oracle[]> => {
      const all = await getOracles();
      return all.filter((o) => o.status === 'active').sort((a, b) => a.expiry - b.expiry);
    },
    refetchInterval: REFETCH_MS,
  });

  const list = data ?? [];
  // Before mount (now === 0) just take the soonest; after, skip any that have
  // ticked past expiry but linger in the cached list until the next refetch.
  const front = (now > 0 ? list.find((o) => o.expiry > now) : list[0]) ?? list[0];
  return front?.oracle_id ?? fallbackId;
}
