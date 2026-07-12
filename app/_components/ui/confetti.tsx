'use client';

/**
 * Confetti — a one-shot celebratory confetti fall across the viewport. Mount it
 * at a happy moment (e.g. a winning claim); key it on something unique per event
 * so each occurrence replays from the top.
 *
 * Purely visual: fixed + pointer-events-none + portaled to <body> (so no ancestor
 * transform can trap the fixed layer), and it renders nothing under
 * prefers-reduced-motion. Pieces start just above the top edge and fall to below
 * the bottom with a little drift + spin, staggered so it rains in rather than
 * dropping all at once. Colors stay on-brand — the up/teal accent, a lighter
 * teal, white, and a warm "prize" gold (no rainbow confetti; §10.3).
 */
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

interface Piece {
  left: number; // % across the viewport (start column)
  dx: number; // horizontal drift over the fall (px)
  rot: number; // total rotation (deg)
  dur: number; // fall duration (ms)
  delay: number; // stagger (ms)
  w: number; // px
  h: number; // px
  color: string;
  round: boolean;
}

const PALETTE = ['var(--up)', 'var(--up)', '#8FF0D4', '#FFFFFF', '#F5C97A'];

// The fall keyframe ships WITH the component (injected inline), not from
// globals.css — a global @keyframes doesn't always hot-reload in step with the
// component JS, which left the pieces frozen at the top with an unresolved
// animation-name. Self-contained = it can't skew from the CSS build. Per-piece
// drift/rotation ride in on the --dx / --pr custom properties set below.
const KEYFRAMES = `
@keyframes confettiFall {
  0% { opacity: 0; transform: translate3d(0, -12vh, 0) rotate(0deg); }
  8% { opacity: 1; }
  85% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--dx), 112vh, 0) rotate(var(--pr)); }
}`;

function makePieces(count: number): Piece[] {
  return Array.from({ length: count }, () => {
    const strip = Math.random() > 0.4; // mostly confetti strips, some round dots
    return {
      left: Math.random() * 100,
      dx: (Math.random() - 0.5) * 160,
      rot: (Math.random() - 0.5) * 720,
      dur: 1600 + Math.random() * 1300,
      delay: Math.random() * 450,
      w: strip ? 5 + Math.random() * 3 : 6 + Math.random() * 4,
      h: strip ? 10 + Math.random() * 6 : 6 + Math.random() * 4,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      round: !strip,
    };
  });
}

export function Confetti({ count = 64 }: { count?: number }) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const pieces = useMemo(() => makePieces(count), [count]);
  if (reduced || typeof document === 'undefined') return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-60 overflow-hidden" aria-hidden>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute top-0 will-change-transform"
          style={
            {
              left: `${p.left}%`,
              width: p.w,
              height: p.h,
              background: p.color,
              borderRadius: p.round ? '9999px' : '1px',
              boxShadow: `0 0 6px -2px ${p.color}`,
              animation: `confettiFall ${p.dur}ms cubic-bezier(0.35,0.15,0.5,1) ${p.delay}ms both`,
              '--dx': `${p.dx}px`,
              '--pr': `${p.rot}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>,
    document.body,
  );
}
