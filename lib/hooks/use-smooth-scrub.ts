'use client';

/**
 * useSmoothScrub — an eased follower for the time-travel slider.
 *
 * The slider used to drive the surface DIRECTLY, so the surface moved at whatever
 * speed the user's finger did: a slow drag read beautifully, but a fast flick threw
 * the whole tape at the mesh in a few frames and the surface appeared to snap
 * violently. The morph lerp can't fix that — the *target* is what's racing.
 *
 * So the slider now only sets a target, and the surface glides toward it under its
 * own motion law:
 *   · exponential approach (TAU) — tracks a slow drag closely, with a light lag,
 *   · a hard speed cap (MAX_SPEED) — no matter how fast the user flings the thumb,
 *     the surface can never traverse more than MAX_SPEED of the window per second.
 *
 * The result: the input stays instant (the thumb follows your finger) while the 3-D
 * stays calm. Returns the smoothed position; the caller renders the surface at it.
 */
import { useEffect, useRef, useState } from 'react';

/** Exponential time constant (s). Lower = tracks the thumb more tightly. */
const TAU = 0.25;
/** Ceiling on travel, in fractions of the recorded window per second. A full-window
 *  fling therefore takes at least ~1/MAX_SPEED seconds to play out. */
const MAX_SPEED = 0.6;
/** Close enough to be considered arrived. */
const EPS = 1e-4;

export function useSmoothScrub(target: number, active: boolean): number {
  const [display, setDisplay] = useState(target);
  const targetRef = useRef(target);
  const displayRef = useRef(target);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (!active) {
      // Not scrubbing — hold the follower at the target so re-entering the scrub
      // starts coherent instead of gliding in from a stale position.
      displayRef.current = targetRef.current;
      return;
    }

    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      // Clamp dt so a backgrounded tab (one huge delta) can't teleport the surface.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const to = targetRef.current;
      const from = displayRef.current;
      const diff = to - from;

      if (Math.abs(diff) < EPS) {
        // Settled — snap once, then idle without re-rendering.
        if (from !== to) {
          displayRef.current = to;
          setDisplay(to);
        }
      } else {
        const eased = diff * (1 - Math.exp(-dt / TAU));
        const capped = Math.sign(diff) * Math.min(Math.abs(eased), MAX_SPEED * dt);
        displayRef.current = from + capped;
        setDisplay(displayRef.current);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return active ? display : target;
}
