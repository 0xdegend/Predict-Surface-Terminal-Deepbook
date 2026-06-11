'use client';

import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { SkewLoaderVisual } from './skew-loader-visual';

/**
 * Initial-load preloader. Rendered in the root layout so it's in the very first
 * HTML (no blank flash on a hard reload); it covers the screen while the app
 * hydrates and the 3-D surface starts assembling, then fades out fast. Runs once
 * per full page load and never re-shows on client navigation — route changes use
 * app/loading.tsx. Deliberately short: speed over spectacle.
 */
const MIN_VISIBLE_MS = 750;

export function Preloader() {
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => {
      const el = ref.current;
      if (!el || reduce) {
        setDone(true);
        return;
      }
      gsap.to(el, {
        autoAlpha: 0,
        duration: 0.4,
        ease: 'power2.inOut',
        onComplete: () => setDone(true),
      });
    }, MIN_VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, []);

  if (done) return null;

  return (
    <div ref={ref} className="fixed inset-0 z-[200] flex items-center justify-center bg-bg-0">
      <SkewLoaderVisual />
    </div>
  );
}
