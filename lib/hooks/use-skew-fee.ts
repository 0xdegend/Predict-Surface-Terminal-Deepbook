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
import { useQuery } from '@tanstack/react-query';
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
