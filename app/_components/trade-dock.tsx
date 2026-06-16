'use client';

/**
 * Responsive home for the trade ticket.
 *
 * Desktop (lg+): `TicketRail` renders the FlowPanel in the right rail, as before.
 * Mobile (<lg): `TradeSheet` renders the same FlowPanel inside a slide-up bottom
 * sheet that opens whenever the user picks a market (surface node / card / table
 * row) — so the ticket comes to the user instead of being buried at the bottom
 * of a long scroll.
 *
 * Each is gated by `useMediaQuery`, so exactly ONE FlowPanel is mounted per
 * breakpoint (no duplicated quote polling or state).
 */
import { useEffect } from 'react';
import { LuX } from 'react-icons/lu';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { FlowPanel } from './flow-panel';
import type { SmileInput } from '@/lib/svi/surface';

const DESKTOP_MQ = '(min-width: 1024px)';

/** Rail ticket heading whose hint follows the hero view: you click the surface
 *  to trade it, but the chart isn't pickable — there you pick from the markets. */
export function TicketTitle() {
  const heroView = useSurfaceStore((s) => s.heroView);
  const hint = heroView === 'chart' ? 'click a market → mint' : 'click surface → mint';
  return (
    <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
      <span className="h-3 w-px bg-accent/70" />
      Trade ticket · {hint}
    </h2>
  );
}

/** Desktop right-rail ticket. Renders nothing on mobile (the sheet takes over). */
export function TicketRail({ inputs, serverNow }: { inputs: SmileInput[]; serverNow: number }) {
  const isDesktop = useMediaQuery(DESKTOP_MQ);
  if (!isDesktop) return null;
  return <FlowPanel inputs={inputs} serverNow={serverNow} />;
}

/** Mobile slide-up trade ticket. Renders nothing on desktop. */
export function TradeSheet({ inputs, serverNow }: { inputs: SmileInput[]; serverNow: number }) {
  const isDesktop = useMediaQuery(DESKTOP_MQ);
  const open = useSurfaceStore((s) => s.ticketSheetOpen);
  const close = useSurfaceStore((s) => s.closeTicketSheet);

  // Esc closes; lock the page behind the sheet while it's open.
  useEffect(() => {
    if (isDesktop || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isDesktop, open, close]);

  if (isDesktop) return null;

  return (
    <>
      {/* Backdrop — tap to dismiss. Sits above the bottom nav (z-40) but below
          the review modal (z-50, portaled to body) so it can layer over the sheet. */}
      <div
        aria-hidden
        onClick={close}
        className={`fixed inset-0 z-44 bg-black/55 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      {/* Sheet — FlowPanel mounts here for the whole mobile session; the sheet just
          slides in/out, so the ticket keeps its state between opens. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trade ticket"
        className={`glass fixed inset-x-0 bottom-0 z-45 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-white/10 shadow-[0_-18px_48px_-12px_rgba(0,0,0,0.8)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? 'translate-y-0' : 'pointer-events-none translate-y-full'
        }`}
      >
        {/* Grab handle + close */}
        <div className="relative flex shrink-0 items-center justify-center px-4 pb-1.5 pt-2.5">
          <span aria-hidden className="h-1 w-9 rounded-full bg-white/20" />
          <button
            type="button"
            onClick={close}
            aria-label="Close trade ticket"
            className="absolute right-3 top-2 rounded-md p-1.5 text-text-3 transition-colors hover:text-text-1"
          >
            <LuX size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-1">
          <FlowPanel inputs={inputs} serverNow={serverNow} />
        </div>
      </div>
    </>
  );
}
