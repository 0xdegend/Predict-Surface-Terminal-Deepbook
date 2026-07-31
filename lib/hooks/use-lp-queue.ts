'use client';

/**
 * useLpQueue — the vault's pending supply/withdraw queue, read straight from the
 * PoolVault (see lib/sui/v2/lp-queue.ts for why the indexer can't be trusted here).
 *
 * Polled on the same ~12s cadence as the rest of the vault reads. `mine` splits out
 * the connected account's own requests, which are the only ones it can cancel.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { readLpQueues, type LpQueues, type LpQueueEntry } from '@/lib/sui/v2/lp-queue';

export interface UseLpQueue {
  queues?: LpQueues;
  /** The connected account's own pending requests, tagged by side. */
  mine: { side: 'supply' | 'withdraw'; entry: LpQueueEntry }[];
  isLoading: boolean;
  error: unknown;
}

export function useLpQueue(accountId?: string): UseLpQueue {
  const client = useV2ReadClient();
  const q = useQuery<LpQueues>({
    queryKey: qkLpQueue.all,
    queryFn: () => readLpQueues(client.core as never),
    refetchInterval: 12_000,
  });

  const mine = useMemo(() => {
    if (!accountId || !q.data) return [];
    const own: { side: 'supply' | 'withdraw'; entry: LpQueueEntry }[] = [];
    for (const e of q.data.supply.entries) {
      if (e.accountId === accountId) own.push({ side: 'supply', entry: e });
    }
    for (const e of q.data.withdraw.entries) {
      if (e.accountId === accountId) own.push({ side: 'withdraw', entry: e });
    }
    return own;
  }, [q.data, accountId]);

  return { queues: q.data, mine, isLoading: q.isLoading, error: q.error };
}

export const qkLpQueue = { all: ['v2', 'lp-queue'] as const };
