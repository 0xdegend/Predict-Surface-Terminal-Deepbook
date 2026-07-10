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
import { fromBase64 } from '@mysten/sui/utils';
import { isEnokiWallet } from '@mysten/enoki';
import { predictV2Config } from '@/config/predict';
import { enokiEnabled } from '@/config/enoki';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { executeSponsored, sponsorshipAvailable } from '@/lib/sui/enoki-sponsor';
import { humanizeV2Error } from '@/lib/sui/v2/abort';
import { isSessionExpired, SESSION_EXPIRED_MESSAGE } from '@/lib/sui/abort';
import { toast } from '@/lib/store/toast-store';
import { readWrapper, readAccountId, readBalance, buildCreateAccountTx, buildDepositTx, buildWithdrawTx } from '@/lib/sui/v2/account';
import { buildMintTx, buildMintBudgetTx, buildRedeemLiveTx, buildRedeemSettledTx, type MintParams, type MintBudgetParams, type RedeemParams } from '@/lib/sui/v2/predict-tx';
import { qkV2 } from '@/lib/api/v2/client';
import {
  buildRequestSupplyTx,
  buildRequestWithdrawTx,
  buildCancelSupplyTx,
  buildCancelWithdrawTx,
} from '@/lib/sui/v2/plp';

export const qkV2Account = {
  wrapper: (owner: string) => ['v2', 'wrapper', owner] as const,
  accountId: (wrapperId: string) => ['v2', 'account-id', wrapperId] as const,
  balance: (wrapperId: string) => ['v2', 'balance', wrapperId] as const,
  plpBalance: (wrapperId: string) => ['v2', 'plp-balance', wrapperId] as const,
  walletDusdc: (owner: string) => ['v2', 'wallet-dusdc', owner] as const,
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

  // The internal account id — the key the indexer files positions/orders under
  // (NOT the wallet owner, NOT the wrapper object). Resolved on-chain from the
  // wrapper; stable, so cache it long.
  const accountIdQ = useQuery({
    queryKey: qkV2Account.accountId(wrapperId ?? ''),
    queryFn: () => readAccountId(client.core, wrapperId!),
    enabled: !!wrapperId && wrapperExists,
    staleTime: Infinity,
  });
  const accountId = accountIdQ.data;

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

  // DUSDC still in the connected wallet (outside the trading account).
  const walletDusdcQ = useQuery({
    queryKey: qkV2Account.walletDusdc(owner ?? ''),
    queryFn: async () => {
      const r = await client.core.getBalance({ owner: owner!, coinType: predictV2Config.quote.coinType });
      return BigInt(r.balance.balance);
    },
    enabled: !!owner,
    refetchInterval: 10_000,
  });

  async function runTx(
    label: string,
    tx: Transaction,
    invalidate: readonly (readonly unknown[])[] = [],
    opts?: { silentSuccess?: boolean },
  ) {
    if (!owner) return null;
    setBusy(label);
    setError(null);
    try {
      let digest: string;
      if (gasless) {
        digest = await executeSponsored(tx, owner);
      } else {
        // Sign with the wallet, execute via our own gRPC client. dapp-kit's
        // combined signAndExecuteTransaction re-parses the wallet's raw response
        // and can crash ("undefined 'txSignatures'") AFTER the tx already landed
        // (seen live with Slush 2026-07-08). Sign-only returns a plain
        // { bytes, signature }; execution then stays fully under our control.
        const { bytes, signature } = await dAppKit.signTransaction({ transaction: tx });
        const result = await client.core.executeTransaction({
          transaction: fromBase64(bytes),
          signatures: [signature],
        });
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
      if (!opts?.silentSuccess) {
        toast.success('Done', { desc: `${digest.slice(0, 14)}…`, href: `https://suiscan.xyz/${predictV2Config.network}/tx/${digest}` });
      }
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

  // Closing a position reduces the lot and pays proceeds into the account —
  // refresh the position list (filed under the indexer account key) and the
  // free balance so a partial close visibly draws down and the payout lands.
  const redeemInvalidations: readonly (readonly unknown[])[] = [
    ...(accountId ? [qkV2.accountPositions(accountId)] : []),
    ...(wrapperId ? [qkV2Account.balance(wrapperId)] : []),
  ];

  return {
    owner,
    wrapperId,
    /** The indexer's account key (positions/orders/history are filed under this,
     *  not the wallet owner). Undefined until the wrapper exists + is resolved. */
    accountId,
    wrapperExists,
    balanceBase,
    plpBalanceBase,
    /** Wallet-held DUSDC (base units) — undefined while the first read is in flight. */
    walletDusdcBase: walletDusdcQ.data,
    busy,
    error,
    /** True for gasless Enoki (Google) accounts — they sign with no wallet
     *  pop-up, so callers can show honest, wallet-aware copy. */
    gasless,
    isLoading: wrapperQ.isLoading,
    /** Create + share the AccountWrapper (standalone tx — required before first deposit/mint). */
    createAccount: () => runTx('create', buildCreateAccountTx(), []),
    deposit: (amount: bigint) =>
      wrapperId
        ? runTx('deposit', buildDepositTx(wrapperId, amount), [
            qkV2Account.balance(wrapperId),
            qkV2Account.walletDusdc(owner ?? ''),
          ])
        : Promise.resolve(null),
    withdraw: (amount: bigint) =>
      wrapperId && owner
        ? runTx('withdraw', buildWithdrawTx(wrapperId, amount, owner), [
            qkV2Account.balance(wrapperId),
            qkV2Account.walletDusdc(owner),
          ])
        : Promise.resolve(null),
    mint: (p: Omit<MintParams, 'wrapperId'>, opts?: { silentSuccess?: boolean }) =>
      wrapperId
        ? runTx('mint', buildMintTx({ ...p, wrapperId }), owner ? [qkV2.accountPositions(owner)] : [], opts)
        : Promise.resolve(null),
    /** Budget mint (mint_exact_amount) — the chain sizes the quantity at
     *  execution, so odds drift can't break the $1 minimum-premium check. */
    mintBudget: (p: Omit<MintBudgetParams, 'wrapperId'>, opts?: { silentSuccess?: boolean }) =>
      wrapperId
        ? runTx('mint', buildMintBudgetTx({ ...p, wrapperId }), owner ? [qkV2.accountPositions(owner)] : [], opts)
        : Promise.resolve(null),
    redeemLive: (p: Omit<RedeemParams, 'wrapperId'>) =>
      wrapperId ? runTx('redeem', buildRedeemLiveTx({ ...p, wrapperId }), redeemInvalidations) : Promise.resolve(null),
    redeemSettled: (p: Omit<RedeemParams, 'wrapperId'>) =>
      wrapperId ? runTx('redeem', buildRedeemSettledTx({ ...p, wrapperId }), redeemInvalidations) : Promise.resolve(null),
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
