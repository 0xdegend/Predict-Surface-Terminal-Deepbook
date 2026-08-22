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
 * IT COVERS ITS OWN HANDOVER. The dialog is asked on `/v2`, which IS the terminal, so
 * answering "I'm new to this" used to close it, show the full terminal for as long as the
 * route took to load, and only then swap to the simple screen — the first thing a
 * self-declared beginner saw was the exact screen they said they weren't ready for. So the
 * overlay stays up until the destination has actually arrived, and the route is prefetched
 * while they're still reading, so there is usually nothing to wait for.
 *
 * Not the shared `Modal`: that one is a solid panel with a close affordance baked in, and
 * it focuses its own panel div — which the global `:focus-visible` rule then ringed in
 * mint, the stray outline this replaces. This is the app's own glass language instead
 * (frosted panel, hairline edge, accent wash on hover), and it keeps focus off anything
 * that can draw a ring.
 *
 * ONLY FOR NEWCOMERS. Asking a trader who has used Skew for weeks whether they are new
 * to prediction markets makes the app look like it has forgotten them. A browser that
 * carries prior Skew state gets [[app/_components/v2/simple-mode-notice]] instead — a
 * line telling them the simple screen exists, which is the only part of this that is
 * news to them. See [[lib/store/visitor]] for how the two are told apart.
 *
 * Route-gated to `/v2`, the landing route. Someone deep-linking to Portfolio came for a
 * specific thing and shouldn't be stopped by an onboarding question.
 *
 * Dark behind `NEXT_PUBLIC_EXPERIENCE_PROMPT` (which also requires simple mode to be on —
 * see `V2_EXPERIENCE_PROMPT_ENABLED`). See [[simple-mode]].
 */
import { useEffect, useRef, useState } from 'react';
import { useScrollLock } from '@/lib/hooks/use-scroll-lock';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import { LuArrowRight } from 'react-icons/lu';
import { TRADE_MODE_ICON, TRADE_MODE_LABEL } from './trade-mode';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useTradeViewStore, tradeHref, type TradeView } from '@/lib/store/trade-view-store';
import { visitorKind } from '@/lib/store/visitor';
import { MASCOT_SRC } from '@/lib/mascot';
import { V2_EXPERIENCE_PROMPT_ENABLED } from '@/config/predict';
import type { IconType } from 'react-icons';

/** The landing route. Root redirects here, so this is where a cold visitor arrives. */
const LANDING = '/v2';

const CHOICES: { view: TradeView; mode: string; answer: string; blurb: string; Icon: IconType }[] = [
  {
    view: 'simple',
    mode: TRADE_MODE_LABEL.simple,
    answer: "I'm new to this",
    blurb: 'Up or down on a short round.',
    Icon: TRADE_MODE_ICON.simple,
  },
  {
    view: 'advanced',
    mode: TRADE_MODE_LABEL.advanced,
    answer: 'I trade already',
    blurb: 'The full terminal.',
    Icon: TRADE_MODE_ICON.advanced,
  },
];

/** Safety net: if a navigation never lands, don't strand a visitor under an overlay
 *  that has no close button. Long enough that a slow route still resolves normally. */
const HANDOVER_TIMEOUT_MS = 8_000;

export function ExperienceModal() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  // The answer lives in localStorage, which the server can't see — without this guard the
  // server renders "not answered" and every returning visitor gets a flash of the dialog.
  const mounted = useMounted();
  const chosen = useTradeViewStore((s) => s.chosen);
  const choose = useTradeViewStore((s) => s.choose);
  // Phones are never asked: the server already lands them on simple mode, and a phone
  // that reaches /v2 only got here by CHOOSING Advanced — asking "which experience?"
  // on top of the one they just picked is a question with no right answer. Matches the
  // app's mobile breakpoint (below lg the nav becomes the bottom dock).
  const phone = useMediaQuery('(max-width: 1023px)');
  const panelRef = useRef<HTMLDivElement>(null);
  // Decided once per browser and frozen (see `visitorKind`); read behind `mounted` so
  // the server, which has no storage, never disagrees with the first client render.
  const newcomer = mounted && visitorKind() === 'new';

  // The route we're handing over to, while the handover is in flight.
  const [pending, setPending] = useState<string | null>(null);
  const arrived = pending != null && pathname === pending;
  // Clear during render rather than in an effect, so the overlay and the destination
  // swap in the SAME commit — an effect would paint one frame of the new page first.
  if (arrived) setPending(null);

  const open =
    V2_EXPERIENCE_PROMPT_ENABLED &&
    mounted &&
    !phone &&
    !arrived &&
    (pending != null || (newcomer && !chosen && pathname === LANDING));

  // Lock the page behind it and move focus in for keyboard users. No Esc listener: the
  // buttons are the only exit.
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
  }, [open]);

  // Warm the simple route while they're still reading the question. Both answers then
  // land instantly; without it, "I'm new to this" pays for a cold server render at
  // exactly the moment the overlay is holding the screen.
  useEffect(() => {
    if (open) router.prefetch('/v2/simple');
  }, [open, router]);

  // Never hold the screen forever on a navigation that didn't happen.
  useEffect(() => {
    if (pending == null) return;
    const t = window.setTimeout(() => setPending(null), HANDOVER_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  if (!open || typeof document === 'undefined') return null;

  function pick(view: TradeView) {
    choose(view);
    const href = tradeHref(view, true);
    // Already here (the advanced answer, on /v2) — nothing to hand over to, just close.
    if (href === pathname) return;
    setPending(href);
    router.push(href);
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
          className="pointer-events-none absolute -right-3 -top-2 h-28 w-28 select-none opacity-90 mask-[linear-gradient(to_bottom,black_62%,transparent)]"
        />

        <div className="relative px-6 pb-6 pt-7">
          <h2 className="max-w-[20ch] text-[19px] font-semibold leading-tight tracking-tight text-text-1 sm:text-[21px]">
            {pending ? 'Setting up your screen' : 'New to prediction markets?'}
          </h2>

          {/* The handover keeps the panel and its height — swapping to a smaller box
              would make the dialog visibly collapse on the way out. */}
          <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
            {CHOICES.map(({ view, mode, answer, blurb, Icon }) => {
              const taken = pending === tradeHref(view, true);
              return (
                <button
                  key={view}
                  type="button"
                  disabled={pending != null}
                  onClick={() => pick(view)}
                  className={`ctrl-soft group flex flex-col gap-2.5 rounded-2xl p-4 text-left transition-opacity duration-300 ${
                    pending && !taken ? 'opacity-25' : 'opacity-100'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-(--accent-line) bg-(--accent-soft)">
                      <Icon size={14} className="text-accent" />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-3">{mode}</span>
                    {taken ? (
                      <i
                        aria-hidden
                        className="ml-auto h-1.5 w-1.5 flex-none rounded-full bg-up"
                        style={{ animation: 'breathe 1.4s ease-in-out infinite' }}
                      />
                    ) : (
                      <LuArrowRight
                        size={14}
                        className="ml-auto flex-none text-text-3 transition-transform duration-200 group-hover:translate-x-1 group-hover:text-accent"
                      />
                    )}
                  </span>
                  <span className="text-[15px] font-semibold leading-none text-text-1">{answer}</span>
                  <span className="text-[12px] leading-none text-text-3">{blurb}</span>
                </button>
              );
            })}
          </div>

          <p className="mt-4 text-center text-[11.5px] text-text-3">
            {pending ? 'One moment.' : 'You can switch any time.'}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
