'use client';

/**
 * useV2Positions — the connected account's open positions.
 *
 * 6-24: from the indexer's `/accounts/{account_id}/positions` endpoint, keyed by
 * the internal ACCOUNT id (NOT the wallet owner).
 *
 * 7-29: folded from the owner's order log, read by the wallet OWNER via the
 * whale-immune tx-sender path (a high-frequency bot buries the account-id scan of
 * the global stream — verified live). Pass `owner` on 7-29; the query still keys by
 * accountId so it dedupes with the history/style fetches for the same account.
 */
import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getAccountPositions, qkV2 } from '@/lib/api/v2/client';
import { getClosedRootsGuard } from '@/lib/portfolio/closed-roots-guard';
import type { V2Position } from '@/lib/api/v2/types';

export function useV2Positions(accountId?: string, owner?: string) {
  // A sticky, reload-surviving memory of already-closed position roots, so a redeem
  // scan that momentarily 429s can't flash a paid position back as claimable. Scoped
  // to the wallet (else the account id) — hygiene only; root ids are globally unique.
  const guard = useMemo(() => getClosedRootsGuard(owner || accountId || ''), [owner, accountId]);
  const q = useQuery<V2Position[]>({
    queryKey: qkV2.accountPositions(accountId ?? ''),
    queryFn: () => getAccountPositions(accountId!, owner, undefined, guard),
    enabled: !!accountId,
    refetchInterval: 12_000,
    // Keep the last good list on screen through a refetch instead of blanking to empty
    // for a beat (the cold-fold takes a few round-trips), so positions never "disappear
    // then reappear" on a poll or a tab refocus.
    placeholderData: keepPreviousData,
  });
  return { positions: q.data ?? [], isLoading: q.isLoading, error: q.error };
}
