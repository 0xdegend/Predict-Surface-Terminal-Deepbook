'use client';

/**
 * usePredictAccountV2 — the trader's on-chain account for the NEW deployment.
 *
 * Custody is the account package (AccountWrapper + Auth + AccumulatorRoot), so
 * there's no manager/server lookup — the wrapper address is derived on-chain and
 * its balance read by simulate. Mirrors the legacy runTx (incl. Enoki gasless
 * sponsorship + finalized-status check) so signing UX stays identical. Used by
 * the v2 trade ticket; portfolio/order listing arrives with the indexer (Phase 3).
 */
import { useState } from 'react';
import { useCurrentAccount, useCurrentClient, useCurrentWallet } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Transaction } from '@mysten/sui/transactions';
import { isEnokiWallet } from '@mysten/enoki';
import { predictV2Config } from '@/config/predict';
import { enokiEnabled } from '@/config/enoki';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { executeSponsored, sponsorshipAvailable } from '@/lib/sui/enoki-sponsor';
import { humanizeV2Error } from '@/lib/sui/v2/abort';
import { isSessionExpired, SESSION_EXPIRED_MESSAGE } from '@/lib/sui/abort';
import { toast } from '@/lib/store/toast-store';
import { readWrapper, readBalance, buildCreateAccountTx, buildDepositTx, buildWithdrawTx } from '@/lib/sui/v2/account';
import { buildMintTx, buildRedeemLiveTx, buildRedeemSettledTx, type MintParams, type RedeemParams } from '@/lib/sui/v2/predict-tx';
import {
  buildRequestSupplyTx,
  buildRequestWithdrawTx,
  buildCancelSupplyTx,
  buildCancelWithdrawTx,
} from '@/lib/sui/v2/plp';

const qkV2Account = {
  wrapper: (owner: string) => ['v2', 'wrapper', owner] as const,
  balance: (wrapperId: string) => ['v2', 'balance', wrapperId] as const,
  plpBalance: (wrapperId: string) => ['v2', 'plp-balance', wrapperId] as const,
};

export function usePredictAccountV2() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const currentWallet = useCurrentWallet();
  const queryClient = useQueryClient();
  const owner = account?.address;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gasless =
    enokiEnabled && !!currentWallet && isEnokiWallet(currentWallet) && sponsorshipAvailable;

  // Wrapper address + existence (derived on-chain via simulate).
  const wrapperQ = useQuery({
    queryKey: qkV2Account.wrapper(owner ?? ''),
    queryFn: () => readWrapper(client.core, owner!),
    enabled: !!owner,
    refetchInterval: 15_000,
  });
  const wrapperId = wrapperQ.data?.wrapperId;
  const wrapperExists = wrapperQ.data?.exists ?? false;

  // Free DUSDC balance in the account (base units).
  const balanceQ = useQuery({
    queryKey: qkV2Account.balance(wrapperId ?? ''),
    queryFn: () => readBalance(client.core, wrapperId!),
    enabled: !!wrapperId && wrapperExists,
    refetchInterval: 10_000,
  });
  const balanceBase = balanceQ.data ?? 0n;

  // Custodied PLP shares (vault liquidity held in the account, base units).
  const plpQ = useQuery({
    queryKey: qkV2Account.plpBalance(wrapperId ?? ''),
    queryFn: () => readBalance(client.core, wrapperId!, predictV2Config.plpCoinType),
    enabled: !!wrapperId && wrapperExists,
    refetchInterval: 10_000,
  });
  const plpBalanceBase = plpQ.data ?? 0n;

  async function runTx(label: string, tx: Transaction, invalidate: readonly (readonly unknown[])[] = []) {
    if (!owner) return null;
    setBusy(label);
    setError(null);
    try {
      let digest: string;
      if (gasless) {
        digest = await executeSponsored(tx, owner);
      } else {
        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        if (result.$kind === 'FailedTransaction') {
          throw new Error(result.FailedTransaction.status?.error?.message ?? 'Transaction failed on-chain');
        }
        digest = result.Transaction.digest;
      }
      const confirmed = await client.core.waitForTransaction({ digest });
      if (confirmed.$kind === 'FailedTransaction') {
        throw new Error(confirmed.FailedTransaction.status?.error?.message ?? 'Transaction aborted on-chain');
      }
      await new Promise((r) => setTimeout(r, 1200));
      for (const key of invalidate) await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: qkV2Account.wrapper(owner) });
      toast.success('Done', { desc: `${digest.slice(0, 14)}…`, href: `https://suiscan.xyz/${predictV2Config.network}/tx/${digest}` });
      return digest;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (gasless && (isSessionExpired(e) || /popup|window closed|Failed to open/i.test(msg))) {
        setError(SESSION_EXPIRED_MESSAGE);
        return null;
      }
      setError(humanizeV2Error(e));
      toast.error('Transaction failed', { desc: humanizeV2Error(e) });
      return null;
    } finally {
      setBusy(null);
    }
  }

  return {
    owner,
    wrapperId,
    wrapperExists,
    balanceBase,
    plpBalanceBase,
    busy,
    error,
    isLoading: wrapperQ.isLoading,
    /** Create + share the AccountWrapper (standalone tx — required before first deposit/mint). */
    createAccount: () => runTx('create', buildCreateAccountTx(), []),
    deposit: (amount: bigint) =>
      wrapperId ? runTx('deposit', buildDepositTx(wrapperId, amount)) : Promise.resolve(null),
    withdraw: (amount: bigint) =>
      wrapperId && owner ? runTx('withdraw', buildWithdrawTx(wrapperId, amount, owner)) : Promise.resolve(null),
    mint: (p: Omit<MintParams, 'wrapperId'>) =>
      wrapperId ? runTx('mint', buildMintTx({ ...p, wrapperId })) : Promise.resolve(null),
    redeemLive: (p: Omit<RedeemParams, 'wrapperId'>) =>
      wrapperId ? runTx('redeem', buildRedeemLiveTx({ ...p, wrapperId })) : Promise.resolve(null),
    redeemSettled: (p: Omit<RedeemParams, 'wrapperId'>) =>
      wrapperId ? runTx('redeem', buildRedeemSettledTx({ ...p, wrapperId })) : Promise.resolve(null),
    /* ---- async vault (PLP) ---- */
    requestSupply: (amount: bigint, deposit?: bigint) =>
      wrapperId ? runTx('supply', buildRequestSupplyTx({ wrapperId, amount, deposit })) : Promise.resolve(null),
    requestWithdraw: (plpAmount: bigint) =>
      wrapperId ? runTx('withdraw-lp', buildRequestWithdrawTx(wrapperId, plpAmount)) : Promise.resolve(null),
    cancelSupply: (index: bigint) =>
      wrapperId ? runTx('cancel', buildCancelSupplyTx(wrapperId, index)) : Promise.resolve(null),
    cancelWithdraw: (index: bigint) =>
      wrapperId ? runTx('cancel', buildCancelWithdrawTx(wrapperId, index)) : Promise.resolve(null),
  };
}
