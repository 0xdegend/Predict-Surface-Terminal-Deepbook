'use client';

/**
 * ExperienceModal — the one question a first-time visitor gets, on landing.
 *
 * New to prediction markets, or already trading? Beginner opens the simple UP/DOWN round
 * screen, trader opens the full terminal. Asked once per browser, then never again.
 *
 * WHY ASK RATHER THAN GUESS: the two screens are aimed at genuinely different people, and
 * a cold landing carries no signal that tells them apart — no wallet, no history. Guessing
 * means one of the two groups lands on the wrong product and mostly leaves rather than
 * hunting for a toggle they have no reason to know exists.
 *
 * The two answers are the ONLY way out: no close button, no Esc, no backdrop click. It is
 * a fork, not a notice, and every path through it lands somewhere the visitor can use.
 *
 * Not the shared `Modal`: that one is a solid panel with a close affordance baked in, and
 * it focuses its own panel div — which the global `:focus-visible` rule then ringed in
 * mint, the stray outline this replaces. This is the app's own glass language instead
 * (frosted panel, hairline edge, accent wash on hover), and it keeps focus off anything
 * that can draw a ring.
 *
 * Route-gated to `/v2`, the landing route. Someone deep-linking to Portfolio came for a
 * specific thing and shouldn't be stopped by an onboarding question.
 *
 * Dark behind `NEXT_PUBLIC_EXPERIENCE_PROMPT` (which also requires simple mode to be on —
 * see `V2_EXPERIENCE_PROMPT_ENABLED`). See [[simple-mode]].
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import { LuZap, LuSlidersHorizontal, LuArrowRight } from 'react-icons/lu';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useTradeViewStore, tradeHref, type TradeView } from '@/lib/store/trade-view-store';
import { MASCOT_SRC } from '@/lib/mascot';
import { V2_EXPERIENCE_PROMPT_ENABLED } from '@/config/predict';
import type { IconType } from 'react-icons';

/** The landing route. Root redirects here, so this is where a cold visitor arrives. */
const LANDING = '/v2';

const CHOICES: { view: TradeView; mode: string; answer: string; blurb: string; Icon: IconType }[] = [
  {
    view: 'simple',
    mode: 'Simple',
    answer: "I'm new to this",
    blurb: 'Up or down on a short round.',
    Icon: LuZap,
  },
  {
    view: 'advanced',
    mode: 'Advanced',
    answer: 'I trade already',
    blurb: 'The full terminal.',
    Icon: LuSlidersHorizontal,
  },
];

export function ExperienceModal() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  // The answer lives in localStorage, which the server can't see — without this guard the
  // server renders "not answered" and every returning visitor gets a flash of the dialog.
  const mounted = useMounted();
  const chosen = useTradeViewStore((s) => s.chosen);
  const choose = useTradeViewStore((s) => s.choose);
  const panelRef = useRef<HTMLDivElement>(null);

  const open = V2_EXPERIENCE_PROMPT_ENABLED && mounted && !chosen && pathname === LANDING;

  // Lock the page behind it and move focus in for keyboard users. No Esc listener: the
  // buttons are the only exit.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  function pick(view: TradeView) {
    choose(view);
    const href = tradeHref(view, true);
    if (href !== pathname) router.push(href);
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose how you want to trade"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-[rgba(6,7,9,0.78)] backdrop-blur-md motion-safe:animate-[fadeIn_160ms_ease-out]" />

      <div
        ref={panelRef}
        tabIndex={-1}
        // Inline `outline` because the global `:focus-visible` rule (a mint 1px ring) sits
        // later in the cascade than any utility class and won this fight on the old dialog.
        style={{ outline: 'none' }}
        className="glass relative w-full max-w-lg overflow-hidden rounded-[22px] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] motion-safe:animate-[popIn_180ms_ease-out]"
      >
        {/* One warm pool of accent behind the header — the only flourish, and the reason
            the panel reads as lit rather than as a grey box. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 h-48"
          style={{ background: 'radial-gradient(60% 100% at 50% 100%, var(--accent-glow), transparent 70%)', opacity: 0.5 }}
        />
        {/* Top-edge highlight, the house alternative to a hard border. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-white/20 to-transparent"
        />

        {/* The fox lives INSIDE the panel — it used to hang off the corner and get clipped. */}
        <Image
          src={MASCOT_SRC.confident}
          alt=""
          width={132}
          height={132}
          aria-hidden
          className="pointer-events-none absolute -right-3 -top-2 h-28 w-28 select-none opacity-90 [mask-image:linear-gradient(to_bottom,black_62%,transparent)]"
        />

        <div className="relative px-6 pb-6 pt-7">
          <h2 className="max-w-[20ch] text-[19px] font-semibold leading-tight tracking-tight text-text-1 sm:text-[21px]">
            New to prediction markets?
          </h2>

          <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
            {CHOICES.map(({ view, mode, answer, blurb, Icon }) => (
              <button
                key={view}
                type="button"
                onClick={() => pick(view)}
                className="ctrl-soft group flex flex-col gap-2.5 rounded-2xl p-4 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-(--accent-line) bg-(--accent-soft)">
                    <Icon size={14} className="text-accent" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-3">{mode}</span>
                  <LuArrowRight
                    size={14}
                    className="ml-auto flex-none text-text-3 transition-transform duration-200 group-hover:translate-x-1 group-hover:text-accent"
                  />
                </span>
                <span className="text-[15px] font-semibold leading-none text-text-1">{answer}</span>
                <span className="text-[12px] leading-none text-text-3">{blurb}</span>
              </button>
            ))}
          </div>

          <p className="mt-4 text-center text-[11.5px] text-text-3">You can switch any time.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
