'use client';

/**
 * useSuinsName — the connected app's reverse SuiNS lookup for one address.
 *
 * Returns the address's default name (`alice.sui`) or null. Cached hard (names
 * are near-static) and deduped by TanStack, so the same address rendered in
 * multiple rows resolves once. Lookups are concurrency-limited in resolveDefaultName.
 */
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { resolveDefaultName } from '@/lib/sui/suins';

export function useSuinsName(address: string | null | undefined): string | null {
  const client = useCurrentClient();
  const q = useQuery({
    queryKey: ['suins', address],
    queryFn: () => resolveDefaultName(client.core, address!),
    enabled: !!address,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  return q.data ?? null;
}
