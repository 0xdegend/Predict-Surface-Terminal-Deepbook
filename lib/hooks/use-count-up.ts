'use client';

import { useEffect, useState } from 'react';

/**
 * Eases a number from 0 → `target` once (easeOutCubic). `setState` only fires
 * inside the rAF callback, so this never cascades a synchronous render. Mount the
 * component that calls this only when you want the animation to run (e.g. inside
 * a modal that returns null when closed) so each open replays from 0.
 */
export function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / ms, 1);
      setV(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
