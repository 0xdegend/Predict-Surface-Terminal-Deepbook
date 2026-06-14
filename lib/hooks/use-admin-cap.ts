'use client';

/**
 * useAdminCap — is the connected wallet the Skew fee admin?
 *
 * Admin = whoever OWNS the `fee_router::AdminCap` object. We ask the chain which
 * objects of that type the connected address owns; if it owns one, it's the
 * admin and we get the cap id needed to sign admin txs. This is on-chain truth
 * (follows the cap if it's ever transferred), and it's only UX gating anyway —
 * the real enforcement is the Move `&AdminCap` requirement, which a non-owner
 * can't satisfy.
 */
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { predictConfig, feeRouterEnabled } from '@/config/predict';

/** Minimal shape of the core client object-read we use (cast to avoid coupling
 *  to the SDK's generic result types). */
interface OwnedObjectsClient {
  listOwnedObjects: (opts: {
    owner: string;
    type?: string;
    limit?: number;
  }) => Promise<{ objects: { objectId: string }[] }>;
}

export function useAdminCap(): { isAdmin: boolean; adminCapId: string | null; isLoading: boolean } {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const owner = account?.address ?? null;
  const type = `${predictConfig.skewFeePackageId}::fee_router::AdminCap`;

  const q = useQuery({
    queryKey: ['admin-cap', owner, predictConfig.skewFeePackageId],
    queryFn: async () => {
      const core = client.core as unknown as OwnedObjectsClient;
      const res = await core.listOwnedObjects({ owner: owner!, type, limit: 1 });
      return res.objects?.[0]?.objectId ?? null;
    },
    enabled: feeRouterEnabled && !!owner,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  return { isAdmin: !!q.data, adminCapId: q.data ?? null, isLoading: q.isLoading };
}
