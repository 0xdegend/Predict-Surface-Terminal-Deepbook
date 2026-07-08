'use client';

/**
 * useVaultV2 — live read of the v2 PLP vault. Two complementary sources:
 *  - on-chain views via simulate (idle balance, PLP supply, pending request
 *    counts, reserves) — authoritative, wallet-free;
 *  - the indexer's `/vaults/:id/state` (shipped ~2026-07) — adds the full pool
 *    NAV (`pool_value`, incl. capital deployed to open markets) and the latest
 *    keeper flush, which the chain exposes no read-only view for. Share price
 *    = pool_value / total_supply.
 */
import { useQuery } from '@tanstack/react-query';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { readVaultState, type VaultState } from '@/lib/sui/v2/plp';
import { getVaultState, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import type { V2VaultServerState } from '@/lib/api/v2/types';

export function useVaultV2() {
  const client = useCurrentClient();
  const q = useQuery<VaultState>({
    queryKey: ['v2', 'vault-state'],
    queryFn: () => readVaultState(client.core),
    refetchInterval: 12_000,
  });
  const navQ = useQuery<V2VaultServerState>({
    queryKey: qkV2.vaultServerState,
    queryFn: () => getVaultState(predictV2Config.shared.poolVault),
    refetchInterval: 15_000,
  });
  return { vault: q.data, nav: navQ.data, isLoading: q.isLoading, error: q.error };
}
