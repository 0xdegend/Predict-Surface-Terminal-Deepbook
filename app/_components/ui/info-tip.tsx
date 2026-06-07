'use client';

/**
 * InfoTip — a small "?" affordance that reveals a plain-language explanation on
 * hover or keyboard focus. Lets the precise term stay for experts while newcomers
 * can learn it.
 *
 * The bubble is rendered in a portal on `document.body` with fixed positioning,
 * so it can never be clipped by a panel's `overflow-hidden` or pushed off the
 * edge of a narrow side rail. It opens below the icon by default, flips above
 * when there isn't room below, and clamps horizontally to stay fully on screen.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuInfo } from 'react-icons/lu';

const WIDTH = 208; // matches the 13rem bubble width
const MARGIN = 8; // min gap from the viewport edge
const GAP = 8; // gap between the icon and the bubble
const FLIP_THRESHOLD = 150; // px of room below before we flip above

// useLayoutEffect on the client (positions before paint, no flicker), useEffect
// on the server (avoids the SSR "does nothing" warning).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type Pos = { left: number; top: number; placement: 'top' | 'bottom' };

export function InfoTip({
  label,
  children,
  size = 11,
}: {
  label: string;
  children: React.ReactNode;
  size?: number;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  useIsoLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Center on the icon, then clamp so the bubble stays fully on screen.
      const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - WIDTH / 2, vw - WIDTH - MARGIN));
      // Prefer opening below; flip above only when there isn't room below.
      const roomBelow = vh - r.bottom;
      const placement: Pos['placement'] =
        roomBelow < FLIP_THRESHOLD && r.top > FLIP_THRESHOLD ? 'top' : 'bottom';
      const top = placement === 'bottom' ? r.bottom + GAP : r.top - GAP;
      setPos({ left, top, placement });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  return (
    <span className="relative inline-flex align-middle">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`What is ${label}?`}
        className="inline-flex text-text-3 transition-colors hover:text-text-2 focus-visible:text-text-2 focus-visible:outline-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <LuInfo size={size} />
      </button>
      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              width: WIDTH,
              transform: pos.placement === 'top' ? 'translateY(-100%)' : undefined,
            }}
            className="glass pointer-events-none z-100 rounded-lg p-2.5 text-left text-[10px] font-normal normal-case leading-relaxed tracking-normal text-text-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)]"
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
