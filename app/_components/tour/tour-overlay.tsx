'use client';

/**
 * Guided product tour — the spotlight + glass-popover wizard (§10.6 motion).
 * Mounted once in the app shell (beside <Toaster />). A single fixed box draws
 * both the dim and the cutout via one giant box-shadow; GSAP morphs that box
 * between steps so the spotlight glides rather than jumps. A transparent
 * full-screen catcher swallows clicks so the page can't be touched mid-tour,
 * and the popover (a solid .glass-menu surface) floats above it.
 *
 * Targets are resolved from `data-tour="..."` anchors at runtime; any step whose
 * anchor isn't mounted (e.g. the ticket before markets load) is filtered out, so
 * the step count always reflects what's actually on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { LuX } from 'react-icons/lu';
import { useTourStore } from '@/lib/store/tour-store';
import { TOUR_STEPS, type TourStep } from '@/lib/tour/steps';

/** Persisted once the tour is finished or skipped — bump the suffix to re-show. */
export const TOUR_SEEN_KEY = 'skew.tour.v1';
/** Breathing room between the target edge and the spotlight cutout. */
const PAD = 8;
const POP_W = 340;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}
interface PopPos {
  left: number;
  top?: number;
  bottom?: number;
}

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function TourOverlay() {
  const active = useTourStore((s) => s.active);
  const step = useTourStore((s) => s.step);
  const setStep = useTourStore((s) => s.setStep);
  const stop = useTourStore((s) => s.stop);

  // Steps whose anchor is actually in the DOM, recomputed each time the tour opens.
  const [steps, setSteps] = useState<TourStep[]>(TOUR_STEPS);
  const [box, setBox] = useState<Box | null>(null);
  const [pop, setPop] = useState<PopPos | null>(null);

  const spotRef = useRef<HTMLDivElement>(null);
  const morphedRef = useRef(false);

  const total = steps.length;
  const current = steps[Math.min(step, total - 1)];

  // Persist "seen" then close. Called by Finish, Skip, Esc, and the catcher.
  const end = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_SEEN_KEY, 'done');
    } catch {
      /* private mode / disabled storage — tour just won't be remembered */
    }
    stop();
  }, [stop]);

  const next = useCallback(() => {
    if (step >= total - 1) end();
    else setStep(step + 1);
  }, [step, total, end, setStep]);

  const prev = useCallback(() => {
    if (step > 0) setStep(step - 1);
  }, [step, setStep]);

  // On open: filter to mounted anchors, reset the morph flag, clamp the index.
  useEffect(() => {
    if (!active) return;
    morphedRef.current = false;
    const present = TOUR_STEPS.filter((s) => document.querySelector(s.target));
    // Syncing React state from a DOM read (which anchors are mounted) — the
    // external-system case the lint rule exempts; it just can't see the query.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSteps(present.length ? present : TOUR_STEPS);
    setStep(0);
  }, [active, setStep]);

  // Measure the active target and place the spotlight box + popover.
  const measure = useCallback(() => {
    const cur = steps[Math.min(step, steps.length - 1)];
    const el = cur ? (document.querySelector(cur.target) as HTMLElement | null) : null;
    if (!el) {
      setBox(null);
      setPop(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const b: Box = {
      top: r.top - PAD,
      left: r.left - PAD,
      width: r.width + PAD * 2,
      height: r.height + PAD * 2,
    };
    setBox(b);

    // Prefer below the target; flip above when there isn't room and the target
    // sits in the lower half. Clamp horizontally so it never leaves the viewport.
    const place: 'top' | 'bottom' =
      b.top + b.height + 190 > vh && b.top > vh * 0.4 ? 'top' : 'bottom';
    const left = Math.min(Math.max(12, b.left), Math.max(12, vw - POP_W - 12));
    setPop(
      place === 'bottom'
        ? { left, top: b.top + b.height + 14 }
        : { left, bottom: vh - b.top + 14 },
    );
  }, [steps, step]);

  // Re-measure on open, step change, scroll, and resize (rAF-throttled).
  useEffect(() => {
    if (!active) return;
    // Initial placement from a DOM measurement (getBoundingClientRect) — DOM→React
    // sync, not a derived-state cascade; the lint rule can't see the measurement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    measure();
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [active, measure]);

  // Bring the target into view when the step changes.
  useEffect(() => {
    if (!active) return;
    const cur = steps[Math.min(step, steps.length - 1)];
    const el = cur ? (document.querySelector(cur.target) as HTMLElement | null) : null;
    el?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
  }, [active, step, steps]);

  // GSAP-morph the spotlight box. First frame snaps into place; after that it glides.
  useEffect(() => {
    if (!box || !spotRef.current) return;
    const reduce = prefersReducedMotion();
    const to = { top: box.top, left: box.left, width: box.width, height: box.height };
    if (!morphedRef.current || reduce) {
      gsap.set(spotRef.current, to);
      morphedRef.current = true;
    } else {
      gsap.to(spotRef.current, { ...to, duration: 0.4, ease: 'power3.out' });
    }
  }, [box]);

  // Keyboard: Esc skips, arrows step.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, end, next, prev]);

  if (!active || !current) return null;

  const reduce = prefersReducedMotion();
  const isLast = step >= total - 1;

  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true" aria-label="Product tour">
      {/* Click catcher — swallows interaction with the page during the tour. */}
      <button
        type="button"
        aria-label="Skip tour"
        onClick={end}
        className="absolute inset-0 h-full w-full cursor-default"
      />

      {/* Spotlight: the dim + cutout in one element (see .tour-spot). */}
      <div ref={spotRef} aria-hidden className="tour-spot pointer-events-none fixed" />

      {/* Popover wizard. */}
      {pop && (
        <div
          className="glass-menu popover-in fixed z-[122] rounded-[12px] p-4"
          style={{
            left: pop.left,
            top: pop.top,
            bottom: pop.bottom,
            width: POP_W,
            transition: reduce ? undefined : 'top 0.4s ease, bottom 0.4s ease, left 0.4s ease',
          }}
        >
          {/* Numbered badge, overlapping the corner like the reference. */}
          <span className="absolute -left-2.5 -top-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-accent font-mono text-[11px] font-semibold tabular-nums text-bg-0 shadow-[0_4px_12px_-2px_var(--accent-glow)]">
            {step + 1}
          </span>

          <div className="mb-1.5 flex items-start justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-text-1">
              {current.title}
            </h2>
            <button
              type="button"
              onClick={end}
              aria-label="Close tour"
              className="-mr-1 -mt-1 rounded-md p-1 text-text-3 transition-colors hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <LuX size={16} />
            </button>
          </div>

          <p className="text-[13px] leading-relaxed text-text-2">{current.body}</p>

          <div className="mt-4 flex items-center justify-between gap-3">
            {/* Progress dots. */}
            <div className="flex items-center gap-1.5" aria-hidden>
              {steps.map((s, i) => (
                <span
                  key={s.id}
                  className={`h-1.5 rounded-full transition-all duration-200 ${
                    i === step ? 'w-4 bg-accent' : 'w-1.5 bg-[var(--line-strong)]'
                  }`}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
              {step > 0 && (
                <button
                  type="button"
                  onClick={prev}
                  className="rounded-md border border-line px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:border-[var(--line-strong)] hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={next}
                className="rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg-0 shadow-[0_0_22px_-8px_var(--accent-glow)] transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {isLast ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
