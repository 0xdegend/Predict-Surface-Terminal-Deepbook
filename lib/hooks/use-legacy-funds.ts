'use client';

/**
 * useLegacyFunds — DUSDC a trader still has sitting in the PREVIOUS deployment's account.
 *
 * A redeploy strands money. Accounts are per release, so cutting over does not move a
 * balance, it just stops the app from looking at where the balance is. The trader sees their
 * portfolio go to zero and has no way, from inside the app, to reach funds that are still
 * entirely theirs on chain.
 *
 * This is the read half. It is deliberately quiet: no polling, cached hard, and it resolves
 * to nothing at all for the overwhelming majority of wallets (anyone who never traded the old
 * release, and everyone who has already reclaimed). Only a wallet with a real leftover
 * balance surfaces anything.
 *
 * Returns zero rather than throwing when the read fails. A transport failure must not
 * announce "you have funds stranded" and must not announce the opposite either — it simply
 * shows nothing, and the next successful read tells the truth.
 */
import { useQuery } from '@tanstack/react-query';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { PREVIOUS_V2_DEPLOYMENT } from '@/config/predict';
import { readLegacyFunds, type LegacyFunds } from '@/lib/sui/v2/legacy-account';

export const qkLegacyFunds = (owner: string, deployment: string) =>
  ['v2', 'legacy-funds', deployment, owner] as const;

export interface LegacyFundsState {
  /** The reclaimable balance, base units. 0n when there is nothing (or nothing known yet). */
  balanceBase: bigint;
  /** The old wrapper to withdraw from, or null. */
  wrapperId: string | null;
  /** Which release the funds are on, or null when there is no previous deployment. */
  deployment: typeof PREVIOUS_V2_DEPLOYMENT;
  isLoading: boolean;
  refetch: () => void;
}

const NOTHING: LegacyFunds = { deployment: '8-06', wrapperId: null, balanceBase: 0n };

export function useLegacyFunds(owner: string | null | undefined): LegacyFundsState {
  const client = useV2ReadClient();
  const deployment = PREVIOUS_V2_DEPLOYMENT;

  const q = useQuery({
    queryKey: qkLegacyFunds(owner ?? '', deployment ?? 'none'),
    queryFn: async () => {
      try {
        return await readLegacyFunds(client.core, owner!, deployment!);
      } catch {
        // Fail quiet, not loud. Claiming funds exist when we could not check would send a
        // trader looking for money that may not be there.
        return NOTHING;
      }
    },
    enabled: !!owner && !!deployment,
    // The old release is frozen from this app's point of view: the only thing that changes
    // this number is the trader's own reclaim, which invalidates the key directly.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    balanceBase: q.data?.balanceBase ?? 0n,
    wrapperId: q.data?.wrapperId ?? null,
    deployment,
    isLoading: q.isLoading,
    refetch: () => void q.refetch(),
  };
}
