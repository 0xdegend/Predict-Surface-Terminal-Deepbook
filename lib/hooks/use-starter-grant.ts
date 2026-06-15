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

export function useStarterGrant(owner: string | null) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function claim() {
    if (!owner || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const { amount } = await claimStarterGrant(owner);
      // Let the fullnode index the transfer, then refetch wallet DUSDC.
      await new Promise((r) => setTimeout(r, 1500));
      await queryClient.invalidateQueries({ queryKey: qk.dusdcBalance(owner) });
      toast.success('Account funded', {
        desc: `${fmtQuote(fromQuote(BigInt(amount)))} ${predictConfig.quote.symbol} added — you're ready to trade`,
      });
    } catch (e) {
      setFailed(true);
      toast.error('Could not fund account', {
        desc: e instanceof Error ? e.message : 'Try the faucet instead',
      });
    } finally {
      setBusy(false);
    }
  }

  return { claim, busy, failed };
}
