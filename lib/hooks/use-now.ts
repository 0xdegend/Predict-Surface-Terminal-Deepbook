'use client';

import { useSyncExternalStore } from 'react';

/**
 * Live wall-clock. All callers share one 1s interval (no per-component timers),
 * and the hook re-renders subscribers each tick so TTL / countdown text updates
 * without refetching any data.
 *
 * Hydration: `getServerSnapshot` returns the server-provided `seed`, so SSR and
 * the first client render match (no mismatch). React then re-reads the live
 * snapshot after subscribing and switches the clock on.
 */
let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  current = Date.now();
  if (!timer) {
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(seed: number): number {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => seed,
  );
}
