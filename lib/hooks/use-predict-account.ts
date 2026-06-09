'use client';

/**
 * usePredictAccount — the one place the trader's on-chain account lives:
 * manager lookup, summary, positions, PnL, wallet DUSDC, plus the create /
 * redeem / withdraw transactions. Shared by the trade-ticket rail and the
 * Portfolio page so the tx logic and cache keys never drift apart.
 *
 * SCALING: every DUSDC amount the server returns for a manager/position is in
 * base units (@6dec). We expose them already de-scaled to human floats, and a
 * single `tradingBalanceBase` bigint for tx math — so callers never re-scale.
 */
import { useState } from 'react';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Transaction } from '@mysten/sui/transactions';
import {
  getManagersByOwner,
  getManagerSummary,
  getManagerPositions,
  getManagerPnl,
  qk,
} from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { humanizeError } from '@/lib/sui/abort';
import { isRedeemableStatus } from '@/lib/portfolio/history';
import { toast } from '@/lib/store/toast-store';
import {
  buildCreateManagerTx,
  buildRedeemTx,
  buildWithdrawFromManagerTx,
  buildWithdrawPlpTx,
  buildMintRangeTx,
  buildRedeemRangeTx,
} from '@/lib/sui/predict-tx';
import type { PositionSummary } from '@/lib/api/types';

/** Friendly label for a runTx action (label may be "redeem-<oracle>-..."). */
function txLabel(label: string): string {
  if (label === 'create') return 'Create account';
  if (label === 'mint') return 'Mint';
  if (label === 'withdraw') return 'Withdraw';
  if (label === 'withdraw-plp') return 'Vault withdrawal';
  if (label === 'mint-range') return 'Mint range';
  if (label === 'redeem-range') return 'Close range';
  if (label.startsWith('redeem')) return 'Close position';
  return 'Transaction';
}

function txSuccessTitle(label: string): string {
  if (label === 'create') return 'Trading account created';
  if (label === 'mint') return 'Position minted';
  if (label === 'withdraw') return 'Withdrawn to wallet';
  if (label === 'withdraw-plp') return 'Redeemed from vault';
  if (label === 'mint-range') return 'Range minted';
  if (label === 'redeem-range') return 'Range closed';
  if (label.startsWith('redeem')) return 'Position closed';
  return 'Transaction confirmed';
}

export function usePredictAccount() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();
  const owner = account?.address ?? null;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  const managersQ = useQuery({
    queryKey: qk.managers(owner ?? ''),
    queryFn: () => getManagersByOwner(owner!),
    enabled: !!owner,
  });
  const managerId = managersQ.data?.[0]?.manager_id ?? null;

  const summaryQ = useQuery({
    queryKey: qk.managerSummary(managerId ?? ''),
    queryFn: () => getManagerSummary(managerId!),
    enabled: !!managerId,
    refetchInterval: 5000,
  });
  const positionsQ = useQuery({
    queryKey: qk.managerPositions(managerId ?? ''),
    queryFn: () => getManagerPositions(managerId!),
    enabled: !!managerId,
    refetchInterval: 5000,
  });
  const pnlQ = useQuery({
    queryKey: qk.managerPnl(managerId ?? ''),
    queryFn: () => getManagerPnl(managerId!),
    enabled: !!managerId,
    refetchInterval: 15_000,
  });
  const dusdcQ = useQuery({
    queryKey: qk.dusdcBalance(owner ?? ''),
    queryFn: async () => {
      const r = await client.core.getBalance({ owner: owner!, coinType: predictConfig.quote.coinType });
      return BigInt(r.balance.balance);
    },
    enabled: !!owner,
    refetchInterval: 10_000,
  });
  const plpQ = useQuery({
    queryKey: qk.plpBalance(owner ?? ''),
    queryFn: async () => {
      const r = await client.core.getBalance({ owner: owner!, coinType: predictConfig.plpCoinType });
      return BigInt(r.balance.balance);
    },
    enabled: !!owner,
    refetchInterval: 10_000,
  });

  // trading_balance is base units (@6dec) — keep a bigint for tx math.
  const tradingBalanceBase = BigInt(Math.round(summaryQ.data?.trading_balance ?? 0));

  async function runTx(
    label: string,
    tx: Transaction,
    invalidate: readonly (readonly unknown[])[] = [],
  ) {
    if (!owner) return;
    setBusy(label);
    setError(null);
    try {
      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (result.$kind === 'FailedTransaction') {
        throw new Error(result.FailedTransaction.status?.error?.message ?? 'Transaction failed on-chain');
      }
      const digest = result.Transaction.digest;
      setLastDigest(digest);
      await client.core.waitForTransaction({ digest });
      await new Promise((r) => setTimeout(r, 1200));
      for (const key of invalidate) await queryClient.invalidateQueries({ queryKey: key });
      toast.success(txSuccessTitle(label), {
        desc: `${digest.slice(0, 14)}…`,
        href: `https://suiscan.xyz/${predictConfig.network}/tx/${digest}`,
      });
      return digest;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Slush WEB popup sometimes reports "closed" even after a successful
      // approval — best-effort refetch so state still surfaces.
      const lostPopup = /closed the wallet window|window closed|popup/i.test(msg);
      setError(lostPopup ? `${humanizeError(e)} Checking…` : humanizeError(e));
      if (!lostPopup) toast.error(`${txLabel(label)} failed`, { desc: humanizeError(e) });
      setTimeout(() => {
        for (const key of invalidate) queryClient.invalidateQueries({ queryKey: key });
        queryClient.invalidateQueries({ queryKey: qk.managers(owner ?? '') });
      }, 2500);
      return null;
    } finally {
      setBusy(null);
    }
  }

  const managerKeys = managerId
    ? [qk.managerSummary(managerId), qk.managerPositions(managerId), qk.managerPnl(managerId)]
    : [];

  async function createManager() {
    return runTx('create', buildCreateManagerTx(), [qk.managers(owner ?? '')]);
  }

  async function redeem(pos: PositionSummary) {
    if (!managerId) return null;
    // A 'redeemable' (settled, in-the-money, unclaimed) position must use the
    // permissionless settled path — see REDEEMABLE_STATUSES.
    const settled = isRedeemableStatus(pos.status);
    return runTx(
      `redeem-${pos.oracle_id}-${pos.strike}-${pos.is_up}`,
      buildRedeemTx({
        managerId,
        oracleId: pos.oracle_id,
        expiry: pos.expiry,
        strike: BigInt(pos.strike),
        isUp: pos.is_up,
        // open_quantity is already the on-chain base quantity (@6dec) — pass it
        // straight through; do NOT re-scale with toQuote.
        quantity: BigInt(Math.round(pos.open_quantity)),
        settled,
      }),
      managerKeys,
    );
  }

  async function withdrawAll() {
    if (!managerId || !owner || tradingBalanceBase <= 0n) return null;
    return runTx(
      'withdraw',
      buildWithdrawFromManagerTx(managerId, tradingBalanceBase, owner),
      [...managerKeys, qk.dusdcBalance(owner)],
    );
  }

  /** Mint a vertical-range position. Strikes are 1e9-scaled, quantity @6dec. */
  async function mintRange(p: {
    oracleId: string;
    expiry: number | bigint;
    lowerStrike: bigint;
    higherStrike: bigint;
    quantity: bigint;
    depositAmount?: bigint;
  }) {
    if (!managerId || !owner) return null;
    return runTx('mint-range', buildMintRangeTx({ managerId, ...p }), [
      ...managerKeys,
      qk.managerRanges(managerId),
      qk.dusdcBalance(owner),
    ]);
  }

  /** Redeem (close, or claim if settled) a vertical-range position. */
  async function redeemRange(p: {
    oracleId: string;
    expiry: number | bigint;
    lowerStrike: bigint;
    higherStrike: bigint;
    quantity: bigint;
  }) {
    if (!managerId) return null;
    return runTx('redeem-range', buildRedeemRangeTx({ managerId, ...p }), [
      ...managerKeys,
      qk.managerRanges(managerId),
      qk.dusdcBalance(owner ?? ''),
    ]);
  }

  /** Redeem PLP back to wallet DUSDC (LP vault withdrawal). `plpAmount` is PLP
   *  base units (@6dec). The chain may reject amounts above the withdrawal
   *  limiter — callers should cap to the vault's available headroom. */
  async function withdrawPlp(plpAmount: bigint) {
    if (!owner || plpAmount <= 0n) return null;
    return runTx('withdraw-plp', buildWithdrawPlpTx(plpAmount, owner), [
      qk.plpBalance(owner),
      qk.dusdcBalance(owner),
      qk.lpFlows(owner),
      qk.vaultSummary,
    ]);
  }

  return {
    owner,
    managerId,
    managersLoading: managersQ.isLoading,
    summary: summaryQ.data,
    positions: positionsQ.data ?? [],
    positionsLoading: positionsQ.isLoading,
    pnl: pnlQ.data,
    dusdcBalance: dusdcQ.data, // base-unit bigint | undefined
    plpBalance: plpQ.data, // base-unit bigint | undefined
    tradingBalanceBase,
    busy,
    error,
    setError,
    lastDigest,
    runTx,
    managerKeys,
    createManager,
    redeem,
    withdrawAll,
    withdrawPlp,
    mintRange,
    redeemRange,
  };
}
