'use client';

/**
 * RewardClaimExperience — orchestrates the Founding Traders reward claim.
 *
 * Owns the hooks (status + the two-step claim) and hands the SAME phase + handlers
 * to whichever presentation fits: the full-screen 3-D gift for everyone, or the
 * calm modal for reduced-motion. The claim itself (treasury -> wallet, then a
 * gasless user-signed deposit) lives in `useRewardClaim`; a dev preview replays it
 * as a no-op simulation. Opened by RewardBanner; never mounts for an ineligible or
 * already-claimed wallet. See [[founding-traders-reward]].
 */
import { useRouter } from 'next/navigation';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { predictV2Config } from '@/config/predict';
import { REWARD_DISPLAY_DUSDC } from '@/config/reward';
import { useRewardClaim, useRewardStatus } from '@/lib/hooks/use-reward';
import { RewardClaimModal } from './reward-claim-modal';
import { RewardGiftOverlay } from './reward-gift-overlay';
import type { RewardClaimView } from './reward-shared';

export function RewardClaimExperience({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const status = useRewardStatus();
  // On success, refetch the shared status query so the banner (same query key) clears.
  const claim = useRewardClaim(() => {
    void status.refetch();
  });
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');

  const sym = predictV2Config.quote.symbol;
  const amount = status.amountDusdc || REWARD_DISPLAY_DUSDC;
  const busy = claim.phase === 'paying' || claim.phase === 'depositing';

  function close() {
    if (busy) return; // never interrupt a payout / signature in flight
    onClose();
    claim.reset(); // start fresh next open (unmounts first, so no visible flip)
  }

  function startTrading() {
    onClose();
    claim.reset();
    router.push('/v2');
  }

  const view: RewardClaimView = {
    open,
    phase: claim.phase,
    amount,
    sym,
    paidDigest: claim.paidDigest,
    inWalletOnly: claim.inWalletOnly,
    error: claim.error,
    busy,
    onClaim: claim.claim,
    onClose: close,
    onStartTrading: startTrading,
  };

  return reduced ? <RewardClaimModal {...view} /> : <RewardGiftOverlay {...view} />;
}
