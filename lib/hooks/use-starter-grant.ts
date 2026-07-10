'use client';

/**
 * useStarterGrant — one-click "fund my account" for first-time traders.
 *
 * Asks /api/starter-grant to drip DUSDC to the connected wallet, then refetches
 * the wallet balance so the low-balance banner clears itself. On any failure it
 * flips `failed` so the UI can fall back to the public faucet link — the grant
 * should never be a dead end. See config/starter-grant.ts.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/api/client';
import { claimStarterGrant } from '@/lib/sui/starter-grant';
import { toast } from '@/lib/store/toast-store';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import { predictConfig } from '@/config/predict';

/** MIST per SUI (SUI is 9-decimal). */
const SUI_DECIMALS = 1_000_000_000;

export interface GrantSuccess {
  /** DUSDC granted, in human units (already de-scaled). */
  amount: number;
  /** SUI dripped for gas, in human units (0 when none — e.g. Google accounts). */
  sui: number;
  /** Executed transfer digest, for the explorer link. */
  digest: string;
}

export interface StarterGrantOptions {
  /** Wallet-balance query keys to refetch on success so the low-balance CTA
   *  clears itself. Defaults to the legacy wallet-DUSDC key; the v2 deployment
   *  passes its own (`qkV2Account.walletDusdc`). */
  invalidateKeys?: readonly (readonly unknown[])[];
  /** Quote-asset symbol for the toast copy (defaults to the legacy config). */
  symbol?: string;
}

/**
 * `includeSui` should be true only for EXTERNAL wallets — Google/zkLogin accounts
 * are gasless via Enoki, so they never need gas SUI. The server still gates the
 * SUI drip on the recipient's actual balance. `opts` lets a second deployment
 * (v2) point the balance refetch + symbol at its own config while sharing the one
 * treasury/route (DUSDC is the same coin on both).
 */
export function useStarterGrant(owner: string | null, includeSui: boolean, opts?: StarterGrantOptions) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Set on a successful grant → the caller pops an animated SuccessModal (a
  // bottom-right toast alone is easy to miss for a gasless, popup-less flow).
  const [success, setSuccess] = useState<GrantSuccess | null>(null);

  async function claim() {
    if (!owner || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const { amount, suiAmount, digest } = await claimStarterGrant(owner, includeSui);
      const sui = Number(BigInt(suiAmount)) / SUI_DECIMALS;
      // Let the fullnode index the transfer, then refetch wallet DUSDC.
      await new Promise((r) => setTimeout(r, 1500));
      const keys = opts?.invalidateKeys ?? [qk.dusdcBalance(owner)];
      for (const key of keys) await queryClient.invalidateQueries({ queryKey: key });
      setSuccess({ amount: fromQuote(BigInt(amount)), sui, digest });
      const sym = opts?.symbol ?? predictConfig.quote.symbol;
      const desc = sui > 0
        ? `${fmtQuote(fromQuote(BigInt(amount)))} ${sym} + ${sui} SUI for gas added`
        : `${fmtQuote(fromQuote(BigInt(amount)))} ${sym} added — you're ready to trade`;
      toast.success('Account funded', { desc });
    } catch (e) {
      setFailed(true);
      toast.error('Could not fund account', {
        desc: e instanceof Error ? e.message : 'Try the faucet instead',
      });
    } finally {
      setBusy(false);
    }
  }

  return { claim, busy, failed, success, clearSuccess: () => setSuccess(null) };
}
