'use client';

/**
 * RewardGiftOverlay — the full-screen "open your gift" moment.
 *
 * A portalled overlay: the Three.js gift fills the screen (lazy, ssr:false) and a
 * bottom HUD carries the copy + the claim controls, both driven by the shared
 * RewardClaimView. Presentational — the orchestrator owns the hooks and routes
 * reduced-motion users to the modal instead, so this is always the animated path.
 * See [[founding-traders-reward]].
 */
import { useEffect, useRef } from 'react';
import { useScrollLock } from '@/lib/hooks/use-scroll-lock';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { LuArrowUpRight, LuX } from 'react-icons/lu';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { MASCOT_SRC } from '@/lib/mascot';
import { REWARD_EXPLORER, REWARD_MOOD, type RewardClaimView } from './reward-shared';

const RewardGiftScene = dynamic(() => import('./reward-gift-scene').then((m) => m.RewardGiftScene), {
  ssr: false,
  loading: () => null,
});

// Full-width, 44px-tall tap targets that stack on a phone; auto-width in a row on
// desktop. min-h-11 keeps them comfortably thumb-hittable.
const BTN_PRIMARY =
  'inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-(--accent-line) bg-up/15 px-5 py-2.5 text-[13px] font-medium text-up transition-colors hover:bg-up/25 disabled:opacity-50 sm:w-auto';
const BTN_GHOST =
  'inline-flex min-h-11 w-full items-center justify-center rounded-xl px-4 py-2.5 text-[13px] text-text-2 transition-colors hover:text-text-1 disabled:opacity-50 sm:w-auto';

export function RewardGiftOverlay(v: RewardClaimView) {
  const { open, phase, amount, sym, busy } = v;
  // Phone-sized viewport: lift/shrink the 3-D gift and stack the HUD controls.
  const compact = useMediaQuery('(max-width: 640px)');
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(v.onClose);
  useEffect(() => {
    onCloseRef.current = v.onClose;
  }, [v.onClose]);

  // Scroll-lock + ESC-to-close (mirrors the shared Modal), depending on `open` alone.
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const headline =
    phase === 'done'
      ? `You received ${amount} ${sym}`
      : phase === 'paying'
        ? 'Unwrapping your gift…'
        : phase === 'depositing'
          ? 'Almost there…'
          : phase === 'error'
            ? 'Almost there'
            : 'A gift for you';

  const body =
    phase === 'done' ? (
      v.inWalletOnly ? (
        <>It’s in your wallet now and moves into your trading account on your first trade.</>
      ) : (
        <>It’s in your trading account, ready to go. Pick a price and place a trade.</>
      )
    ) : phase === 'paying' ? (
      <>Sending your reward.</>
    ) : phase === 'depositing' ? (
      <>Tucking it into your trading account.</>
    ) : phase === 'error' ? (
      <>{v.error ?? 'We couldn’t complete the claim just now.'} Your reward is still waiting for you.</>
    ) : (
      <>
        You’re one of the first to trade on Skew. Here’s {amount} {sym} to keep going.
      </>
    );

  const buttons =
    phase === 'done' ? (
      <button onClick={v.onStartTrading} className={BTN_PRIMARY}>
        Start trading
      </button>
    ) : phase === 'error' ? (
      <>
        <button onClick={v.onClose} className={BTN_GHOST}>
          Close
        </button>
        <button onClick={v.onClaim} className={BTN_PRIMARY}>
          Try again
        </button>
      </>
    ) : busy ? null : (
      <>
        <button onClick={v.onClose} className={BTN_GHOST}>
          Maybe later
        </button>
        <button onClick={v.onClaim} className={BTN_PRIMARY}>
          Claim {amount} {sym}
        </button>
      </>
    );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Claim your reward"
      className="fixed inset-0 z-60 motion-safe:animate-[fadeIn_200ms_ease-out]"
    >
      {/* dark, teal-tinted vignette behind the 3-D */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_38%,rgba(14,32,28,0.72),rgba(6,7,9,0.94))] backdrop-blur-sm" />

      {/* the gift, full-bleed and non-interactive (no controls to grab) */}
      <div className="pointer-events-none absolute inset-0">
        <RewardGiftScene phase={phase} reduced={false} compact={compact} />
      </div>

      {/* close — hidden while a payout / signature is in flight. 44px hit area,
          clear of the notch. */}
      {!busy && (
        <button
          onClick={v.onClose}
          aria-label="Close"
          className="absolute right-3 z-20 flex h-11 w-11 items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-white/5 hover:text-text-1"
          style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <LuX size={18} />
        </button>
      )}

      {/* bottom HUD */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3 bg-linear-to-t from-black/90 via-black/60 to-transparent px-5 pt-12 text-center outline-none sm:px-6 sm:pt-16"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <span className="relative mb-1 inline-flex h-14 w-14 items-center justify-center sm:h-16 sm:w-16">
          <span className="absolute inset-0 rounded-full bg-(--accent-soft) blur-md" aria-hidden />
          {/* eslint-disable-next-line @next/next/no-img-element -- matches MascotPeek */}
          <img
            src={MASCOT_SRC[REWARD_MOOD[phase]]}
            alt=""
            className="relative h-full w-full object-contain drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]"
          />
        </span>

        <h2 className="text-balance text-[21px] font-semibold tracking-tight text-text-1 sm:text-[26px]">
          {headline}
        </h2>
        <p className="max-w-[42ch] text-[13px] leading-relaxed text-text-2">{body}</p>

        {phase === 'done' && v.paidDigest && (
          <a
            href={REWARD_EXPLORER(v.paidDigest)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-text-3 transition-colors hover:text-accent"
          >
            View on explorer
            <LuArrowUpRight size={12} />
          </a>
        )}

        {buttons && (
          <div className="mt-2 flex w-full max-w-xs flex-col-reverse items-stretch gap-2 sm:w-auto sm:max-w-none sm:flex-row sm:items-center sm:justify-center">
            {buttons}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
