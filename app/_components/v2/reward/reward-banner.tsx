'use client';

/**
 * RewardBanner — the Founding Traders reward invite.
 *
 * Shows ONLY to a connected wallet that is on the frozen allowlist and hasn’t
 * claimed yet, and only when the operator has switched the reward on
 * (NEXT_PUBLIC_REWARD_ENABLED). `useRewardStatus` reports `eligible: false` while
 * it loads, so nothing flashes for an ineligible wallet. Dismissing it persists
 * (localStorage) so a trader who isn’t ready isn’t nagged — but it stays claimable
 * from wherever the reward surfaces next.
 *
 * The CTA opens RewardClaimExperience (Phase 3 = a clean claim dialog; Phase 4 will
 * swap in the 3-D gift reveal behind this same trigger). Two placements:
 *   - `strip` (default) — a full-bleed bar for the trade screen, next to the mobile
 *     fund banner.
 *   - `card` — a rounded panel for inside a padded container (the portfolio).
 * See [[founding-traders-reward]].
 */
import { useState } from 'react';
import { LuGift, LuX } from 'react-icons/lu';
import { REWARD_VISIBLE, REWARD_CAMPAIGN, REWARD_DISPLAY_DUSDC } from '@/config/reward';
import { predictV2Config } from '@/config/predict';
import { useRewardStatus } from '@/lib/hooks/use-reward';
import { RewardClaimExperience } from './reward-claim-experience';

const DISMISS_KEY = `skew:reward-banner-dismissed:${REWARD_CAMPAIGN}`;

export function RewardBanner({ variant = 'strip' }: { variant?: 'strip' | 'card' }) {
  const { eligible, claimed, amountDusdc } = useRewardStatus();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode — just hide for this session */
    }
    setDismissed(true);
  }

  // Dark unless the reward is on (or previewing) AND this wallet is eligible and
  // hasn’t claimed.
  if (!REWARD_VISIBLE || !eligible || claimed || dismissed) return null;

  const sym = predictV2Config.quote.symbol;
  const amount = amountDusdc || REWARD_DISPLAY_DUSDC;

  const shell =
    variant === 'card'
      ? 'mb-4 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-3'
      : 'border-b border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2.5';

  return (
    <>
      <div className={shell}>
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--accent-line)] bg-up/10 text-up">
            <LuGift size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium text-text-1">
              A gift for our founding traders
            </p>
            <p className="hidden truncate text-[11px] text-text-2 sm:block">
              You’re one of the first to trade on Skew. Claim {amount} {sym} to keep going.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-lg border border-[var(--accent-line)] bg-up/15 px-3 py-1.5 text-[12px] font-medium text-up transition-colors hover:bg-up/25"
          >
            Claim {amount} {sym}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="ctrl-soft -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:text-text-1"
          >
            <LuX size={13} />
          </button>
        </div>
      </div>
      <RewardClaimExperience open={open} onClose={() => setOpen(false)} />
    </>
  );
}
