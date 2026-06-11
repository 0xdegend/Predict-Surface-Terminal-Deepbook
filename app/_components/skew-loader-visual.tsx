'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import gsap from 'gsap';

/**
 * The animated Skew mark — a modern glassmorphism loader shared by the initial
 * Preloader and the route-change loading fallback. A frosted glass tile holds a
 * floating mark over an accent glow that the glass frosts; a light shimmer sweeps
 * across and a slim indeterminate bar tracks progress. No spinner.
 *
 * Motion is layered so it never waits on JS: the bar + shimmer run on CSS (paint
 * before hydration), and GSAP adds the mark's float + the glow pulse once
 * hydrated. Reduced-motion is honored (GSAP guard + the global CSS block).
 */
export function SkewLoaderVisual({ size = 52 }: { size?: number }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => {
      gsap.to('.skl-logo', {
        y: -6,
        scale: 1.06,
        duration: 0.95,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: -1,
      });
      gsap.to('.skl-glow', {
        opacity: 0.95,
        scale: 1.16,
        duration: 1.05,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: -1,
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={root}
      role="status"
      aria-label="Loading"
      className="relative flex items-center justify-center"
    >
      {/* Accent glow behind the glass — gives the frost something to blur. */}
      <span
        aria-hidden
        className="skl-glow absolute h-44 w-44 rounded-full opacity-70 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--accent-glow), transparent 70%)' }}
      />

      {/* Frosted glass tile. */}
      <div className="glass relative flex flex-col items-center gap-5 overflow-hidden rounded-[22px] px-9 py-8 shadow-[0_36px_90px_-32px_rgba(0,0,0,0.85)]">
        {/* top-edge sheen — the glass catching light */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-7 top-0 h-px bg-linear-to-r from-transparent via-white/25 to-transparent"
        />
        {/* diagonal shimmer sweep */}
        <span
          aria-hidden
          className="skl-shimmer pointer-events-none absolute inset-y-0 left-0 w-2/5 bg-linear-to-r from-transparent via-white/10 to-transparent"
        />

        {/* the mark — light skew-mark for instant load */}
        <Image
          src="/skew-mark.png"
          alt=""
          width={size}
          height={size}
          priority
          className="skl-logo relative object-contain drop-shadow-[0_0_18px_var(--accent-glow)]"
          style={{ width: size, height: size }}
        />

        {/* slim indeterminate progress bar */}
        <div className="relative h-[3px] w-28 overflow-hidden rounded-full bg-white/[0.07]">
          <span
            aria-hidden
            className="skl-bar absolute inset-y-0 left-0 w-1/3 rounded-full"
            style={{ background: 'linear-gradient(90deg, transparent, var(--accent), transparent)' }}
          />
        </div>
      </div>

      <span className="sr-only">Loading Skew…</span>
    </div>
  );
}
