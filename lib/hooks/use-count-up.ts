'use client';

import { useEffect, useRef, useState } from 'react';

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

/**
 * Rolls a LIVE value toward each new `target` (easeOutCubic) from the value
 * currently shown — an odometer feel for a number that updates repeatedly (e.g. a
 * price tick), NOT a replay from 0. A new target mid-roll glides on from wherever
 * the digits are, so ticks never jump. The FIRST real value snaps in (no rocket
 * up from 0), a `null` target stays `null` (no data yet), and a reduced-motion
 * preference snaps every change. Returns the animating value (or null).
 */
export function useTweenTo(target: number | null, ms = 650): number | null {
  const [shown, setShown] = useState<number | null>(target);
  // Mirrors `shown` so each new tween starts from the on-screen value (not the
  // last target, which would jump if a tick lands mid-roll).
  const shownRef = useRef<number | null>(target);
  const rafRef = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    const from = shownRef.current;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // No data, first value, no change, or reduced motion → snap straight there
    // (scheduled on the next frame so the state write stays out of the effect body).
    if (target == null || from == null || from === target || reduce) {
      shownRef.current = target;
      rafRef.current = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(rafRef.current);
    }
    const start = performance.now();
    const delta = target - from;
    const tick = (now: number) => {
      const t = Math.min((now - start) / ms, 1);
      const eased = from + delta * (1 - Math.pow(1 - t, 3));
      shownRef.current = eased;
      setShown(eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else {
        shownRef.current = target;
        setShown(target);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, ms]);

  return shown;
}
