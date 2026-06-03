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
import {
  buildCreateManagerTx,
  buildRedeemTx,
  buildWithdrawFromManagerTx,
} from '@/lib/sui/predict-tx';
import type { PositionSummary } from '@/lib/api/types';

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
      return digest;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Slush WEB popup sometimes reports "closed" even after a successful
      // approval — best-effort refetch so state still surfaces.
      const lostPopup = /closed the wallet window|window closed|popup/i.test(msg);
      setError(lostPopup ? `${humanizeError(e)} Checking…` : humanizeError(e));
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
    const settled = pos.status === 'settled' || pos.status === 'awaiting_settlement';
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

  return {
    owner,
    managerId,
    managersLoading: managersQ.isLoading,
    summary: summaryQ.data,
    positions: positionsQ.data ?? [],
    positionsLoading: positionsQ.isLoading,
    pnl: pnlQ.data,
    dusdcBalance: dusdcQ.data, // base-unit bigint | undefined
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
  };
}
