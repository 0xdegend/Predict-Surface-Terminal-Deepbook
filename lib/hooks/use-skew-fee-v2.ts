'use client';

/**
 * useSkewFeeV2 — the live v2 Skew fee (our `skew_fee_v2::fee_router`).
 *
 * `useSkewFeeV2` reads the on-chain `FeeConfig` (rate + treasury) so the ticket, the mint
 * hook, and the admin panel all agree on ONE source of truth — the chain, not a local
 * setting. `useSkewFeeV2AdminCap` answers "does this wallet hold the AdminCap" for gating
 * the admin controls (real enforcement is the Move `&AdminCap`; this is only UX).
 *
 * Both no-op cleanly when the router isn't published for the active network
 * (`feeRouterV2Enabled` false): the rate reads 0/disabled and the app charges no fee. The
 * admin WRITES live in the panel itself (via `usePredictAccountV2().runTx` +
 * `buildSetSkewFeeBpsTx`/`buildSetSkewTreasuryTx`) so this file never imports the account
 * hook — keeping the dependency one-way (the account hook imports the rate from here).
 */
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { predictV2Config, feeRouterV2Enabled } from '@/config/predict';
import { readSkewFeeConfig, type SkewFeeConfig } from '@/lib/sui/v2/skew-fee';

export const qkSkewFeeV2 = {
  config: (configId: string) => ['v2', 'skew-fee', 'config', configId] as const,
  adminCap: (owner: string, pkg: string) => ['v2', 'skew-fee', 'admin-cap', owner, pkg] as const,
};

export interface SkewFeeV2 extends SkewFeeConfig {
  /** True when the router is published for this network. False → no fee charged. */
  enabled: boolean;
  isLoading: boolean;
  refetch: () => void;
}

/** Live rate + treasury from the on-chain FeeConfig. Disabled → 0 bps, no fee. */
export function useSkewFeeV2(): SkewFeeV2 {
  const client = useV2ReadClient();
  const configId = predictV2Config.feeConfigV2Id;

  const q = useQuery({
    queryKey: qkSkewFeeV2.config(configId),
    queryFn: () => readSkewFeeConfig(client.core),
    enabled: feeRouterV2Enabled,
    // The rate rarely changes (an admin action), so read it lazily and refresh occasionally.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  return {
    feeBps: feeRouterV2Enabled ? (q.data?.feeBps ?? 0) : 0,
    treasury: q.data?.treasury ?? '',
    enabled: feeRouterV2Enabled,
    isLoading: feeRouterV2Enabled && q.isLoading,
    refetch: () => void q.refetch(),
  };
}

/** Minimal shape of the core client object-read (cast to avoid the SDK's generic types). */
interface OwnedObjectsClient {
  listOwnedObjects: (opts: {
    owner: string;
    type?: string;
    limit?: number;
  }) => Promise<{ objects: { objectId: string }[] }>;
}

/** Does the connected wallet own the fee router's AdminCap? On-chain truth (follows the cap
 *  if transferred); UX gating only. */
export function useSkewFeeV2AdminCap(): {
  isAdmin: boolean;
  adminCapId: string | null;
  isLoading: boolean;
} {
  const account = useCurrentAccount();
  const client = useV2ReadClient();
  const owner = account?.address ?? null;
  const pkg = predictV2Config.skewFeeV2PackageId;
  const type = `${pkg}::fee_router::AdminCap`;

  const q = useQuery({
    queryKey: qkSkewFeeV2.adminCap(owner ?? '', pkg),
    queryFn: async () => {
      const core = client.core as unknown as OwnedObjectsClient;
      const res = await core.listOwnedObjects({ owner: owner!, type, limit: 1 });
      return res.objects?.[0]?.objectId ?? null;
    },
    enabled: feeRouterV2Enabled && !!owner,
    staleTime: 60_000,
  });

  return { isAdmin: !!q.data, adminCapId: q.data ?? null, isLoading: q.isLoading };
}
