'use client';

/**
 * useV2TraderAccount — resolve ANY wallet owner to its internal v2 account id,
 * on-chain (readWrapper → readAccountId). The indexer files positions/orders
 * under the account id, not the wallet, so a public trader profile needs this to
 * read `/accounts/{account_id}/…` for someone other than the connected user.
 *
 * No wallet required — the dApp-kit client answers these simulate reads for any
 * address. The owner→account mapping is immutable, so it's cached forever; a
 * `null` result means the owner never created a v2 account (no positions exist).
 */
import { useQuery } from '@tanstack/react-query';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { readWrapper, readAccountId } from '@/lib/sui/v2/account';

export const qkV2Trader = {
  account: (owner: string) => ['v2', 'trader-account', owner] as const,
};

export interface UseV2TraderAccount {
  accountId?: string;
  /** False once resolved when this owner has no v2 account (no positions possible). */
  exists: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useV2TraderAccount(owner?: string): UseV2TraderAccount {
  const client = useV2ReadClient();
  const q = useQuery({
    queryKey: qkV2Trader.account(owner ?? ''),
    queryFn: async () => {
      const w = await readWrapper(client.core, owner!);
      if (!w.exists) return null;
      return readAccountId(client.core, w.wrapperId);
    },
    enabled: !!owner,
    staleTime: Infinity,
  });
  return {
    accountId: q.data ?? undefined,
    exists: q.data != null,
    isLoading: q.isLoading,
    error: q.error instanceof Error ? q.error.message : null,
  };
}
