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
import { useCurrentAccount, useCurrentClient, useCurrentWallet, useDAppKit } from '@mysten/dapp-kit-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Transaction } from '@mysten/sui/transactions';
import { isEnokiWallet } from '@mysten/enoki';
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
import { executeSponsored, sponsorshipAvailable } from '@/lib/sui/enoki-sponsor';
import { enokiEnabled } from '@/config/enoki';
import {
  buildCreateManagerTx,
  buildRedeemTx,
  buildWithdrawFromManagerTx,
  buildWithdrawPlpTx,
  buildMintRangeTx,
  buildRedeemRangeTx,
  buildCashOutTx,
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
  if (label === 'cash-out') return 'Cash out';
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
  if (label === 'cash-out') return 'DUSDC sent';
  if (label.startsWith('redeem')) return 'Position closed';
  return 'Transaction confirmed';
}

export function usePredictAccount() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const wallet = useCurrentWallet();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();
  const owner = account?.address ?? null;

  // A zkLogin (Enoki) wallet can't pay its own gas — route its txs through the
  // Enoki sponsor (gasless). Any other wallet signs+executes + pays normally.
  const gasless = enokiEnabled && sponsorshipAvailable && !!wallet && isEnokiWallet(wallet);

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
    opts?: { allowedAddresses?: string[] },
  ) {
    if (!owner) return;
    setBusy(label);
    setError(null);
    try {
      let digest: string;
      if (gasless) {
        // Enoki sponsors the gas (server route, private key); the wallet signs.
        digest = await executeSponsored(tx, owner, opts?.allowedAddresses);
      } else {
        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        if (result.$kind === 'FailedTransaction') {
          throw new Error(result.FailedTransaction.status?.error?.message ?? 'Transaction failed on-chain');
        }
        digest = result.Transaction.digest;
      }
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

  /**
   * Close (or claim, if settled) a binary position. `quantityBase` is an
   * optional partial amount in on-chain base units (@6dec); omit it to close
   * the full open lot. The contract keys positions by MarketKey + quantity, so
   * a partial close is just a redeem with quantity < open_quantity — the
   * remainder stays open and can be closed later.
   */
  async function redeem(pos: PositionSummary, quantityBase?: bigint) {
    if (!managerId) return null;
    // A 'redeemable' (settled, in-the-money, unclaimed) position must use the
    // permissionless settled path — see REDEEMABLE_STATUSES.
    const settled = isRedeemableStatus(pos.status);
    // open_quantity is already the on-chain base quantity (@6dec) — pass it
    // straight through; do NOT re-scale with toQuote. Clamp any partial amount
    // to (0, open] so we never over-redeem or send a zero-quantity tx.
    const open = BigInt(Math.round(pos.open_quantity));
    const quantity =
      quantityBase == null ? open : quantityBase <= 0n ? 0n : quantityBase > open ? open : quantityBase;
    if (quantity <= 0n) return null;
    return runTx(
      `redeem-${pos.oracle_id}-${pos.strike}-${pos.is_up}`,
      buildRedeemTx({
        managerId,
        oracleId: pos.oracle_id,
        expiry: pos.expiry,
        strike: BigInt(pos.strike),
        isUp: pos.is_up,
        quantity,
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

  /**
   * Cash out DUSDC to an external wallet (for zkLogin / Google users who can't
   * export a key). Drains the manager free balance first, then wallet DUSDC, up
   * to `amountBase` (base units, @6dec), and transfers it to `destination` in one
   * gasless transaction. Returns null on bad input.
   */
  async function cashOut(destination: string, amountBase: bigint) {
    if (!managerId || !owner) return null;
    const walletBase = dusdcQ.data ?? 0n;
    const available = tradingBalanceBase + walletBase;
    const amount = amountBase > available ? available : amountBase;
    if (amount <= 0n) return null;
    // Prefer the manager's free balance (the allowlisted withdraw keeps the tx
    // sponsorable); spill over to wallet coins only if needed.
    const fromManager = amount > tradingBalanceBase ? tradingBalanceBase : amount;
    const fromWallet = amount - fromManager;
    return runTx(
      'cash-out',
      buildCashOutTx({ managerId, fromManager, fromWallet, destination }),
      [...managerKeys, qk.dusdcBalance(owner)],
      { allowedAddresses: [destination, owner] },
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
    cashOut,
    /** True when the connected wallet is a zkLogin (Enoki) account. */
    isZkLogin: gasless,
  };
}
