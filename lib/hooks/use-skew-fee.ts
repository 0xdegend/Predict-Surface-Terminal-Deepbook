'use client';

/**
 * useSkewFee — the live builder-fee rate for the trade ticket.
 *
 * `routerEnabled` says whether the skew_fee router is deployed (config ids set);
 * `feeBps` is the on-chain rate (100 = 1.00%). Mint flows route through the fee
 * router only when `feeBps > 0`; otherwise they use the plain `predict::mint`
 * path, so the app works identically before the router is published.
 */
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { predictConfig, feeRouterEnabled } from '@/config/predict';
import { readSkewFeeBps } from '@/lib/sui/skew-fee';

export function useSkewFee(): { feeBps: number; routerEnabled: boolean } {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const owner = account?.address ?? null;

  const q = useQuery({
    queryKey: ['skew-fee-bps', predictConfig.skewFeePackageId, predictConfig.feeConfigId],
    queryFn: () => readSkewFeeBps(client.core, owner!),
    enabled: feeRouterEnabled && !!owner,
    staleTime: 60_000,
    refetchInterval: 300_000,
    refetchOnWindowFocus: false,
  });

  return { feeBps: q.data ?? 0, routerEnabled: feeRouterEnabled };
}

/** Minimal core-client object read for the FeeConfig (cast — see useAdminCap). */
interface GetObjectsClient {
  getObjects: (opts: {
    objectIds: string[];
    include?: { json?: boolean };
  }) => Promise<{ objects: ({ json?: unknown } | Error)[] }>;
}

export interface FeeConfigState {
  feeBps: number;
  treasury: string;
}

/**
 * useFeeConfig — the full on-chain FeeConfig (fee_bps + treasury) for the admin
 * panel. Reads the shared object's JSON directly so we get both fields at once.
 */
export function useFeeConfig(): {
  feeBps: number;
  treasury: string;
  isLoading: boolean;
  refetch: UseQueryResult<FeeConfigState | null>['refetch'];
} {
  const client = useCurrentClient();
  const q = useQuery({
    queryKey: ['fee-config', predictConfig.feeConfigId],
    queryFn: async (): Promise<FeeConfigState | null> => {
      const core = client.core as unknown as GetObjectsClient;
      const res = await core.getObjects({ objectIds: [predictConfig.feeConfigId], include: { json: true } });
      const obj = res.objects?.[0];
      if (!obj || obj instanceof Error) return null;
      const json = (obj as { json?: { fee_bps?: string | number; treasury?: string } }).json ?? null;
      return { feeBps: Number(json?.fee_bps ?? 0), treasury: String(json?.treasury ?? '') };
    },
    enabled: feeRouterEnabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  return {
    feeBps: q.data?.feeBps ?? 0,
    treasury: q.data?.treasury ?? '',
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}
