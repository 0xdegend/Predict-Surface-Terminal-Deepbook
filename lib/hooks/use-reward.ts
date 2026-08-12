'use client';

/**
 * use-reward — the Founding Traders reward: status (eligible / claimed) + the claim
 * orchestration for the connected wallet.
 *
 * Claim is the two-step delivery the on-chain gating forces (deposit is owner-gated):
 *   1. the server treasury sends 50 DUSDC to the user's WALLET (/api/reward/claim),
 *   2. the USER signs a deposit wallet -> account (gasless for Google via Enoki; the
 *      server dripped a little SUI for external wallets so they can sign it).
 * If step 2 fails or is skipped, the 50 DUSDC is safe in the wallet and the trade
 * ticket auto-deposits it on the first mint — so a claim never loses funds. Signing +
 * gasless sponsorship reuse the account hook. See [[founding-traders-reward]].
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { REWARD_VISIBLE, REWARD_PREVIEW } from '@/config/reward';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { claimReward, RewardClaimError } from '@/lib/sui/reward';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RewardStatus {
  eligible: boolean;
  claimed: boolean;
  amountDusdc: number;
  amountBaseUnits: string;
  campaign: string;
}

/** Read whether the connected wallet is eligible + has claimed. Dark unless the reward
 *  is enabled AND a wallet is connected. */
export function useRewardStatus() {
  const account = useCurrentAccount();
  const owner = account?.address;
  const q = useQuery<RewardStatus>({
    queryKey: ['reward', 'status', owner ?? ''],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/reward/status?address=${owner}`, { signal });
      if (!res.ok) throw new Error(`reward status ${res.status}`);
      return (await res.json()) as RewardStatus;
    },
    enabled: REWARD_VISIBLE && !!owner,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  return {
    // In preview, force-eligible so the banner + experience surface for any wallet
    // (the real payout stays server-gated, so nothing can be claimed for real).
    eligible: REWARD_PREVIEW ? !!owner : (q.data?.eligible ?? false),
    claimed: REWARD_PREVIEW ? false : (q.data?.claimed ?? false),
    amountDusdc: q.data?.amountDusdc ?? 0,
    loading: q.isLoading,
    refetch: q.refetch,
  };
}

/** The claim's progress. `paying` = treasury -> wallet; `depositing` = user signs the
 *  deposit into their account; `done` = in the account, trade-ready. */
export type RewardClaimPhase = 'idle' | 'paying' | 'depositing' | 'done' | 'error';

export interface RewardClaimState {
  phase: RewardClaimPhase;
  /** Set once the treasury payout confirms (funds are at least in the wallet). */
  paidDigest: string | null;
  /** True when the payout landed but the deposit step didn't finish — funds are safe
   *  in the wallet and the first trade will auto-deposit them. */
  inWalletOnly: boolean;
  error: string | null;
}

const INITIAL: RewardClaimState = { phase: 'idle', paidDigest: null, inWalletOnly: false, error: null };

/**
 * Orchestrate the claim end to end. Returns `claim()` + live state. Never signs on its
 * own — the deposit is a real user-approved transaction (gasless for Google).
 */
export function useRewardClaim(onDone?: () => void) {
  const acct = usePredictAccountV2();
  const [state, setState] = useState<RewardClaimState>(INITIAL);

  async function claim(): Promise<void> {
    if (!acct.owner || state.phase === 'paying' || state.phase === 'depositing') return;
    setState({ ...INITIAL, phase: 'paying' });

    // Preview: play the choreography with no network / no signing / no ledger write,
    // so the full gift moment can be reviewed safely. See [[founding-traders-reward]].
    if (REWARD_PREVIEW) {
      await sleep(1200);
      setState((s) => ({ ...s, phase: 'depositing' }));
      await sleep(1200);
      setState({ phase: 'done', paidDigest: null, inWalletOnly: false, error: null });
      onDone?.();
      return;
    }

    let paidDigest: string | null = null;
    let amountBase = 0n;
    try {
      // 1) treasury -> wallet. `includeSui` for external wallets so they can sign the deposit.
      const payout = await claimReward(acct.owner, { includeSui: !acct.gasless });
      paidDigest = payout.digest;
      amountBase = BigInt(payout.amount);
      setState((s) => ({ ...s, phase: 'depositing', paidDigest }));

      // 2) user signs the deposit wallet -> account. The wrapper exists for every
      //    eligible trader (they've traded); create it first only in the rare case it
      //    doesn't, then deposit on the caller's retry.
      if (!acct.wrapperExists) {
        await acct.createAccount();
        // The wrapper id resolves on the next render; surface as wallet-only so the
        // funds are clearly safe and a retry (or first trade) completes the deposit.
        setState({ phase: 'done', paidDigest, inWalletOnly: true, error: null });
        onDone?.();
        return;
      }
      const depositDigest = await acct.deposit(amountBase);
      if (!depositDigest) throw new Error('deposit-declined');
      setState({ phase: 'done', paidDigest, inWalletOnly: false, error: null });
      onDone?.();
    } catch (e) {
      // Payout done but deposit failed/declined → funds are in the wallet, not lost.
      if (paidDigest) {
        setState({ phase: 'done', paidDigest, inWalletOnly: true, error: null });
        onDone?.();
        return;
      }
      const msg =
        e instanceof RewardClaimError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Could not claim the reward';
      setState({ phase: 'error', paidDigest: null, inWalletOnly: false, error: msg });
    }
  }

  function reset() {
    setState(INITIAL);
  }

  return { claim, reset, ...state };
}
