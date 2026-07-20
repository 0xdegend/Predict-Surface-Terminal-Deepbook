'use client';

/**
 * useDebounced — the value, but only after it has stopped changing for `ms`.
 *
 * Used to tell "the trader is still dragging the strike" apart from "the trader
 * has settled on a strike": work hangs off the settled value, so a slider drag
 * doesn't kick off a recompute (or a fetch) on every frame it passes over.
 */
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
