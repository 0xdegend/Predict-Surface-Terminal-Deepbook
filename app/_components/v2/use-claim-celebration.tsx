'use client';

/**
 * useClaimCelebration — the shared "you won" moment for a successful winning
 * claim, so the full Portfolio grid and the compact trade-rail panel celebrate
 * identically (both redeem through the same V2RedeemModal).
 *
 * `celebrate(payout, digest)` fires it; `overlay` is the render node to drop into
 * the panel — a SuccessModal (payout counting up, explorer link) plus a one-shot
 * ParticleBurst keyed to the digest so it replays per claim. Losing/worthless
 * clears and live closes don't call this; they keep the quiet success toast.
 */
import { useState } from 'react';
import { SuccessModal } from '@/app/_components/ui/success-modal';
import { ParticleBurst } from '@/app/_components/ui/particle-burst';
import { predictV2Config } from '@/config/predict';

export function useClaimCelebration() {
  const [done, setDone] = useState<{ amount: number; digest: string } | null>(null);

  const celebrate = (amount: number, digest: string) => setDone({ amount, digest });

  const overlay = (
    <>
      <SuccessModal
        open={!!done}
        onClose={() => setDone(null)}
        title="Payout claimed"
        eyebrow="Claimed"
        amount={done?.amount ?? 0}
        sym={predictV2Config.quote.symbol}
        sub="paid into your trading account"
        digest={done?.digest}
      />
      {done && <ParticleBurst key={done.digest} />}
    </>
  );

  return { celebrate, overlay };
}
