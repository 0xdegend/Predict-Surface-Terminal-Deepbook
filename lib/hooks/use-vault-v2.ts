'use client';

/**
 * useVaultV2 — live read of the v2 PLP vault's on-chain state (idle balance, PLP
 * supply, pending request counts, reserves). No wallet needed; polls via simulate.
 */
import { useQuery } from '@tanstack/react-query';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { readVaultState, type VaultState } from '@/lib/sui/v2/plp';

export function useVaultV2() {
  const client = useCurrentClient();
  const q = useQuery<VaultState>({
    queryKey: ['v2', 'vault-state'],
    queryFn: () => readVaultState(client.core),
    refetchInterval: 12_000,
  });
  return { vault: q.data, isLoading: q.isLoading, error: q.error };
}
