'use client';

/**
 * Responsive home for the v2 trade ticket — the Latest-deployment mirror of the
 * legacy trade-dock (TicketRail / TradeSheet).
 *
 * Desktop (lg+): `V2TicketRail` renders the ticket in the right rail, as before.
 * Mobile (<lg): `V2TradeSheet` renders the same ticket inside a slide-up bottom
 * sheet that opens whenever the user picks a market (table row / card side) — so
 * the ticket comes to the user instead of being buried at the bottom of a long
 * scroll (the old "rail stacks under the markets" behaviour).
 *
 * Each is gated by `useMediaQuery`, so exactly ONE V2TradeTicket is mounted per
 * breakpoint (no duplicated account/grant state). Same glass language, grab
 * handle, backdrop, Esc-to-close, and body-scroll lock as the legacy sheet; the
 * review/success modals portal to body at z-50 so they layer over this sheet.
 */
import { useEffect } from 'react';
import { LuX } from 'react-icons/lu';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { V2TradeTicket } from './trade-ticket';
import { V2PriceChart } from './price-chart';
import { StaleFeedOverlay } from './stale-feed-overlay';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const DESKTOP_MQ = '(min-width: 1024px)';

type TicketProps = { market: V2Market | null; pricer?: LivePricer; serverNow: number };

/** Desktop right-rail ticket. Renders nothing on mobile (the sheet takes over). */
export function V2TicketRail({ market, pricer, serverNow }: TicketProps) {
  const isDesktop = useMediaQuery(DESKTOP_MQ);
  if (!isDesktop) return null;
  return (
    // Positioned so the stale-feed overlay can blur + block the ticket (and its
    // "Loading live price…" state) when the upstream spot feed freezes.
    <div className="relative">
      <V2TradeTicket market={market} pricer={pricer} serverNow={serverNow} />
      <StaleFeedOverlay />
    </div>
  );
}

/** Mobile slide-up trade ticket. Renders nothing on desktop. */
export function V2TradeSheet({ market, pricer, serverNow }: TicketProps) {
  const isDesktop = useMediaQuery(DESKTOP_MQ);
  const open = useV2TradeStore((s) => s.ticketSheetOpen);
  const close = useV2TradeStore((s) => s.closeTicketSheet);

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
      {/* Backdrop — tap to dismiss. Sits above the bottom nav (which tucks away)
          but below the review modal (z-50, portaled to body). */}
      <div
        aria-hidden
        onClick={close}
        className={`fixed inset-0 z-44 bg-black/55 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      {/* Sheet — the ticket mounts here for the whole mobile session; the sheet
          just slides in/out, so it keeps its state (step, stake) between opens. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trade ticket"
        className={`glass fixed inset-x-0 bottom-0 z-45 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-white/10 shadow-[0_-18px_48px_-12px_rgba(0,0,0,0.8)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? 'translate-y-0' : 'pointer-events-none translate-y-full'
        }`}
      >
        {/* Grab handle + close */}
        <div className="relative flex shrink-0 items-center justify-center px-4 pb-2 pt-3">
          <span aria-hidden className="h-1 w-9 rounded-full bg-white/20" />
          {/* z-30 lifts the close hit-area ABOVE the scrollable ticket body below.
              The button is taller than this slim handle row, so its lower half (the
              visible ✕) overflows into the body — a later sibling that, without this
              lift, painted over it and swallowed the tap on touch (the X did nothing
              on mobile). z-30 also clears the stale-feed overlay (z-20), so the sheet
              always closes. p-2 gives a comfortable finger target. */}
          <button
            type="button"
            onClick={close}
            aria-label="Close trade ticket"
            className="absolute right-2 top-1.5 z-30 rounded-md p-2 text-text-3 transition-colors hover:text-text-1"
          >
            <LuX size={18} />
          </button>
        </div>
        <div className="scroll-quiet relative min-h-0 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-1">
          {/* Mobile: the chart renders inside binary step 1 (read-only — taps scroll
              the sheet), only mounted while the sheet is open + a market is picked.
              Its strike/win-zone overlays track the payout slider live. */}
          <V2TradeTicket
            market={market}
            pricer={pricer}
            serverNow={serverNow}
            mobile
            chart={
              open && market ? (
                <div className="pointer-events-none mb-3 h-36 overflow-hidden rounded-xl bg-black/20">
                  <V2PriceChart market={market} pricer={pricer} />
                </div>
              ) : null
            }
          />
          {/* Blurs the ticket + blocks trading when the upstream spot feed freezes. */}
          <StaleFeedOverlay />
        </div>
      </div>
    </>
  );
}
