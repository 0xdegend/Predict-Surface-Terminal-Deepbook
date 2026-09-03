'use client';

/**
 * AnimatedNumber — eases a number to its new value when it changes (count-up),
 * for the live KPI reads. Snaps instantly under prefers-reduced-motion. The
 * displayed value is run through `format`, so it works for currency, %, counts.
 */
import { useEffect, useRef, useState } from 'react';

export function AnimatedNumber({
  value,
  format,
  className,
  durationMs = 480,
  from,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  durationMs?: number;
  /** Where the FIRST paint starts from. Left unset the number mounts already at
   *  `value` and only later changes ease; pass 0 for a hero that counts up on arrival. */
  from?: number;
}) {
  const [display, setDisplay] = useState(from ?? value);
  // The figure on screen RIGHT NOW, which is where the next ease starts from. It used to
  // be "the last target", set in the cleanup, and that had two costs: a value that changed
  // mid-ease jumped to the old target before easing on, and under React's dev-only double
  // mount the cleanup stamped the target as the start, so a count-up from zero never
  // played in development at all.
  const shownRef = useRef(from ?? value);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = shownRef.current;
    const to = value;
    if (reduce || start === to || !Number.isFinite(start) || !Number.isFinite(to)) {
      shownRef.current = to;
      setDisplay(to);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      // Clamped at 0 as well: a frame's timestamp is the frame's START, which can sit
      // before the effect ran, and a negative progress eases past the start figure in
      // the wrong direction (a positive score opened on a negative frame).
      const p = Math.min(1, Math.max(0, (t - t0) / durationMs));
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      const v = p < 1 ? start + (to - start) * eased : to;
      shownRef.current = v;
      setDisplay(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return <span className={className}>{format(display)}</span>;
}
