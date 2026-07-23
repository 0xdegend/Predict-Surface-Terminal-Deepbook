'use client';

/**
 * SurfaceTradePopoverV2 — click-to-mint right on the v2 surface (legacy
 * SurfaceTradePopover parity, rebuilt on the v2 engine).
 *
 * This is just the on-canvas CHROME: a centered, dismissable glass card anchored
 * over the surface. The trade ticket itself is the shared `V2CompactTicket` (also
 * used by the co-pilot's pop-out modal) — clicking a node anchors this card in a
 * GLANCE state (Up/Down + strike slider + fair odds); "Preview trade" expands to
 * the ticket state (stake + leverage + cost estimate → mint). Range mode builds a
 * band from two surface clicks. All the pricing/mint logic lives in the shared
 * ticket, so the rail, the surface and the co-pilot never disagree on the trade.
 */
import { useEffect, useRef } from 'react';
import { LuX } from 'react-icons/lu';
import { V2CompactTicket } from '../ticket/compact-ticket';
import type { SmileInput } from '@/lib/svi/surface';
import type { V2Market } from '@/lib/api/v2/types';

export function SurfaceTradePopoverV2({
  market,
  input,
  now,
  onClose,
}: {
  market: V2Market | null;
  input: SmileInput | null;
  now: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Escape + outside-click dismissal. A pointerdown on the canvas (to pick a new
  // node) closes this first; onPick then re-opens it for the new spot.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onDown(e: PointerEvent) {
      const target = e.target as Element | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      // The confirm modal portals to <body> — a click on it must not dismiss the
      // popover, or the modal unmounts mid-confirm and the mint never runs.
      if (target.closest('[role="dialog"], [role="presentation"]')) return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  // Centered over the surface so it never clips at an edge and grows
  // symmetrically when expanding glance→ticket (legacy parity).
  return (
    <div
      ref={ref}
      className="popover-in glass pointer-events-auto absolute left-1/2 top-1/2 z-20 max-h-[calc(100%-1.5rem)] w-76 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overflow-x-hidden rounded-xl shadow-[0_18px_48px_-12px_rgba(0,0,0,0.8)]"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-2 top-2 z-10 rounded p-1 text-text-3 transition-colors hover:text-text-1"
      >
        <LuX size={13} />
      </button>
      <V2CompactTicket market={market} input={input} now={now} onClose={onClose} />
    </div>
  );
}
