'use client';

/**
 * MascotPeek — the Skew fox cropped into a panel's top-right corner, reacting to
 * context. Purely decorative (aria-hidden): every bit of meaning stays in text,
 * so a screen reader never depends on the art.
 *
 * Designed to sit behind a Modal's header/content (z-0 here; the Modal lifts its
 * text to z-10), with a corner-anchored mask so the fox emerges from the corner
 * and fades into the panel — never a hard rectangle over the dialog. Swapping
 * `mood` remounts the image (via `key`), replaying the peek-in so the character
 * visibly *reacts* (e.g. thinking → confident when you hover the mint button).
 */
import { useEffect } from 'react';
import { MASCOT_SRC, MASCOT_GLOW, preloadMascots, type MascotMood } from '@/lib/mascot';

export function MascotPeek({ mood, size = 104 }: { mood: MascotMood; size?: number }) {
  // Warm all expressions on mount so mood swaps are instant (no flash).
  useEffect(() => {
    preloadMascots();
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-0 top-0 z-0 overflow-hidden"
      style={{ width: size, height: size }}
    >
      {/* mood bloom — the only glow, kept faint so it doesn't compete with the surface */}
      <span
        className="absolute inset-0"
        style={{ background: `radial-gradient(70% 70% at 78% 22%, ${MASCOT_GLOW[mood]}, transparent 72%)` }}
      />
      {/* the fox — corner-masked so it dissolves toward the panel; keyed on mood
          so each change replays the peek-in reaction. */}
      <img
        key={mood}
        src={MASCOT_SRC[mood]}
        alt=""
        draggable={false}
        width={size}
        height={size}
        className="relative h-full w-full select-none object-contain opacity-90 motion-safe:animate-[mascotPeek_440ms_cubic-bezier(0.34,1.4,0.64,1)_both]"
        style={{
          WebkitMaskImage: 'radial-gradient(125% 125% at 100% 0%, #000 42%, transparent 78%)',
          maskImage: 'radial-gradient(125% 125% at 100% 0%, #000 42%, transparent 78%)',
        }}
      />
    </div>
  );
}
