'use client';

/**
 * ParticleBurst — a one-shot celebratory burst overlaid on the viewport. Mount it
 * at a happy moment (e.g. a winning claim); key it on something unique per event
 * so each occurrence replays the animation from scratch.
 *
 * Purely visual: fixed + pointer-events-none + portaled to <body> (so no ancestor
 * transform can trap the fixed layer), and it renders nothing under
 * prefers-reduced-motion. Particles pop from `origin` (viewport %) along random
 * vectors, then drift out and fade via the `particleBurst` keyframe. Colors stay
 * on-brand — the up/teal accent, a lighter teal, white, and a warm "prize" gold.
 */
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

interface Particle {
  dx: number;
  dy: number;
  rot: number;
  scale: number;
  dur: number;
  delay: number;
  size: number;
  color: string;
  round: boolean;
}

// Weighted toward teal (the app's one accent); white sparkle + a little gold for
// the "you won" read. No rainbow confetti — it stays inside the palette (§10.3).
const PALETTE = ['var(--up)', 'var(--up)', '#8FF0D4', '#FFFFFF', '#F5C97A'];

function makeParticles(count: number): Particle[] {
  return Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 70 + Math.random() * 140;
    return {
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist + 24, // slight gravity — they settle downward
      rot: (Math.random() - 0.5) * 360,
      scale: 0.45 + Math.random() * 0.7,
      dur: 850 + Math.random() * 550,
      delay: Math.random() * 120,
      size: 5 + Math.random() * 5,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      round: Math.random() > 0.5,
    };
  });
}

export function ParticleBurst({
  count = 32,
  origin = { x: 50, y: 42 },
}: {
  count?: number;
  /** Burst origin as a percentage of the viewport (defaults near a centered modal's badge). */
  origin?: { x: number; y: number };
}) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const particles = useMemo(() => makeParticles(count), [count]);
  if (reduced || typeof document === 'undefined') return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-60 overflow-hidden" aria-hidden>
      <div className="absolute" style={{ left: `${origin.x}%`, top: `${origin.y}%` }}>
        {particles.map((p, i) => (
          <span
            key={i}
            className="absolute left-0 top-0 will-change-transform"
            style={
              {
                width: p.size,
                height: p.size,
                background: p.color,
                borderRadius: p.round ? '9999px' : '2px',
                boxShadow: `0 0 7px -1px ${p.color}`,
                // `both` so the 0% (hidden) state holds through the stagger delay —
                // otherwise particles flash at full size/opacity before popping.
                animation: `particleBurst ${p.dur}ms cubic-bezier(0.2,0.7,0.3,1) ${p.delay}ms both`,
                '--dx': `${p.dx}px`,
                '--dy': `${p.dy}px`,
                '--pr': `${p.rot}deg`,
                '--ps': `${p.scale}`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
