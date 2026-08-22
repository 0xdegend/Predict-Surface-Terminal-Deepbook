'use client';

/**
 * useRedeemFlow — closing or claiming a position, wherever that is offered from.
 *
 * The trade rail, the Portfolio and (now) simple mode's "Your bets" all let a trader act
 * on a position, and all three must do exactly the same thing: the same confirm dialog
 * with its win/loss preview and partial close, the same celebration on a settled win, and
 * the same closed-root bookkeeping. This is that flow in one place so they cannot drift.
 *
 * Three details worth knowing, all of them learned the hard way:
 *
 *   - A settled WIN is claimed silently and celebrated instead of toasted, so the payout
 *     lands as a moment rather than a notification.
 *   - A full close is written to the closed-roots guard immediately. Without it the row
 *     lingers until a fold poll reconciles the redeem, which reads as "I just claimed it
 *     and it's still showing". Partial closes leave a remainder, so only a full one counts.
 *   - Sample rows and rows with no order id are not real positions; confirming one just
 *     shuts the dialog.
 *
 * The caller renders `overlay` once, anywhere in its tree, and calls `open(position)` from
 * a button. See [[keeper-redeem-read-gap]] for why a settled winner usually needs no
 * action at all.
 */
import { useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { V2RedeemModal } from './redeem-modal';
import { useClaimCelebration } from './use-claim-celebration';
import { winningClaimPayout, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { retireRootIfDone } from '@/lib/portfolio/retire-root';

export function useRedeemFlow() {
  const acct = usePredictAccountV2();
  const [redeeming, setRedeeming] = useState<V2PortfolioPosition | null>(null);
  const { celebrate, overlay: celebration } = useClaimCelebration();

  async function handleConfirm(p: V2PortfolioPosition, closeQuantity: bigint) {
    if (p.sample || !p.marketId || p.orderId == null || closeQuantity <= 0n) {
      setRedeeming(null);
      return;
    }
    const args = { marketId: p.marketId, orderId: p.orderId, closeQuantity };
    const payout = winningClaimPayout(p, closeQuantity);
    const digest = p.settled
      ? await acct.redeemSettled(args, payout != null ? { silentSuccess: true } : undefined)
      : await acct.redeemLive(args);

    // Retires the row on a landed full close OR on a chain refusal ("nothing left to
    // close" = the keeper already paid this settled winner). `lastError()` not
    // `acct.error`: React state is stale inside this awaiting closure. See retire-root.
    const retired = retireRootIfDone(
      { digest, fullClose: closeQuantity >= (p.qtyBase ?? 0n), lastError: acct.lastError() },
      p.positionRootId ?? (p.orderId != null ? String(p.orderId) : ''),
      acct.owner || acct.accountId || '',
    );
    if (!digest) {
      if (retired) {
        setRedeeming(null);
        acct.clearError();
      }
      return;
    }
    setRedeeming(null);
    if (payout != null) celebrate(payout, digest);
  }

  return {
    busy: !!acct.busy,
    open: (p: V2PortfolioPosition) => setRedeeming(p),
    overlay: (
      <>
        <V2RedeemModal
          position={redeeming}
          busy={!!acct.busy}
          onConfirm={handleConfirm}
          onClose={() => setRedeeming(null)}
        />
        {celebration}
      </>
    ),
  };
}
