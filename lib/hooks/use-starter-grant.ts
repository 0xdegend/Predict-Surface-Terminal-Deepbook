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
import { claimStarterGrant, StarterGrantError } from '@/lib/sui/starter-grant';
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
  // The server's reason code for the last failure (null when it succeeded or
  // hasn't run). Lets callers tell a benign "already funded once" apart from a
  // real error and steer the user to the faucet instead of showing an alarm.
  const [failedCode, setFailedCode] = useState<string | null>(null);
  // Set on a successful grant → the caller pops an animated SuccessModal (a
  // bottom-right toast alone is easy to miss for a gasless, popup-less flow).
  const [success, setSuccess] = useState<GrantSuccess | null>(null);

  const sym = opts?.symbol ?? predictConfig.quote.symbol;

  /**
   * Returns the outcome so an orchestrating caller (the onboarding modal, which
   * chains fund → create-account) can branch without reading the async state
   * back through a stale closure. `ok` is true on a real grant; `already_funded`
   * comes back as `ok:false` with that code so the caller can proceed to create
   * the account and steer top-ups to the faucet. onClick callers ignore it.
   */
  async function claim(): Promise<{ ok: boolean; code: string | null }> {
    if (!owner || busy) return { ok: false, code: 'busy' };
    setBusy(true);
    setFailed(false);
    setFailedCode(null);
    try {
      const { amount, suiAmount, digest } = await claimStarterGrant(owner, includeSui);
      const sui = Number(BigInt(suiAmount)) / SUI_DECIMALS;
      // Let the fullnode index the transfer, then refetch wallet DUSDC.
      await new Promise((r) => setTimeout(r, 1500));
      const keys = opts?.invalidateKeys ?? [qk.dusdcBalance(owner)];
      for (const key of keys) await queryClient.invalidateQueries({ queryKey: key });
      setSuccess({ amount: fromQuote(BigInt(amount)), sui, digest });
      const desc = sui > 0
        ? `${fmtQuote(fromQuote(BigInt(amount)))} ${sym} + ${sui} SUI for gas added`
        : `${fmtQuote(fromQuote(BigInt(amount)))} ${sym} added. You're ready to trade.`;
      toast.success('Account funded', { desc });
      return { ok: true, code: null };
    } catch (e) {
      const code = e instanceof StarterGrantError ? e.code : 'error';
      setFailed(true);
      setFailedCode(code);
      // "Already funded" isn't an error the user did anything wrong — this wallet
      // used its one-time grant in an earlier session (a returning wallet, or the
      // same Google sign-in, which maps to the same on-chain address). Say so
      // calmly and point at the faucet; the CTA below also flips to the faucet.
      if (code === 'already_funded') {
        toast.info('Wallet already funded', {
          desc: `This wallet used its starter grant already. Use the faucet for more ${sym}.`,
        });
      } else {
        toast.error('Could not fund account', {
          desc: e instanceof Error ? e.message : 'Try the faucet instead',
        });
      }
      return { ok: false, code };
    } finally {
      setBusy(false);
    }
  }

  return { claim, busy, failed, failedCode, success, clearSuccess: () => setSuccess(null) };
}
