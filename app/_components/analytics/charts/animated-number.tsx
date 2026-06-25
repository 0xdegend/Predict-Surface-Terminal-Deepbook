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
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  durationMs?: number;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = fromRef.current;
    const to = value;
    if (reduce || from === to || !Number.isFinite(from) || !Number.isFinite(to)) {
      setDisplay(to);
      fromRef.current = to;
      return;
    }
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = to;
    };
  }, [value, durationMs]);

  return <span className={className}>{format(display)}</span>;
}
