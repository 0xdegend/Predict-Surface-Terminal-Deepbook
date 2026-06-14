'use client';

/**
 * Guided product tour — a fixed bottom dock of step pills + a moving spotlight.
 *
 * The dock stays pinned to the bottom of the viewport the whole time, so the
 * controls never travel and you never have to scroll to find them (the home
 * route isn't a fixed 100vh). Clicking a step pill spotlights that section and
 * scrolls it into view; only the spotlight glides (GSAP), which reads far calmer
 * than a popover hopping around the page.
 *
 * Targets resolve from `data-tour="..."` anchors at runtime; any step whose
 * anchor isn't mounted (e.g. the ticket before markets load) is filtered out, so
 * the pills always reflect what's actually on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { LuX, LuChevronRight, LuCheck } from 'react-icons/lu';
import { useTourStore } from '@/lib/store/tour-store';
import { TOUR_STEPS, type TourStep } from '@/lib/tour/steps';

/** Persisted once the tour is finished or skipped — bump the suffix to re-show. */
export const TOUR_SEEN_KEY = 'skew.tour.v1';
/** Breathing room between the target edge and the spotlight cutout. */
const PAD = 8;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
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

  // Measure the active target → the spotlight box. The nav dock is fixed, so we
  // only ever position the cutout.
  const measure = useCallback(() => {
    const cur = steps[Math.min(step, steps.length - 1)];
    const el = cur ? (document.querySelector(cur.target) as HTMLElement | null) : null;
    if (!el) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setBox({
      top: r.top - PAD,
      left: r.left - PAD,
      width: r.width + PAD * 2,
      height: r.height + PAD * 2,
    });
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

  // Bring the target into view when the step changes. `block: center` keeps it
  // clear of the fixed dock at the bottom.
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

      {/* Fixed bottom dock — the navigation never moves. */}
      <div
        className="pointer-events-none fixed inset-x-0 z-[122] flex justify-center px-3"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
      >
        <div className="glass-dock popover-in pointer-events-auto w-full max-w-3xl rounded-2xl p-3 sm:p-4">
          {/* Header — eyebrow + progress + close. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-text-3">
              Guided tour <span className="text-text-2">· step {step + 1} of {total}</span>
            </span>
            <div className="flex items-center gap-1">
              {!isLast && (
                <button
                  type="button"
                  onClick={end}
                  className="rounded-md px-2 py-1 text-[11px] font-medium text-text-3 transition-colors hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Skip tour
                </button>
              )}
              <button
                type="button"
                onClick={end}
                aria-label="Close tour"
                className="-mr-1 rounded-md p-1 text-text-3 transition-colors hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <LuX size={16} />
              </button>
            </div>
          </div>

          {/* Step cards (reference style) — number + short label, the active one
              highlighted. flex-1 + short labels keep all five on one row with no
              scroll; clicking a card spotlights that section. */}
          <div className="mt-3 flex gap-1.5">
            {steps.map((s, i) => {
              const isActive = i === step;
              const done = i < step;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStep(i)}
                  title={s.title}
                  aria-current={isActive ? 'step' : undefined}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors ${
                    isActive
                      ? 'border-up/50 bg-[var(--accent-soft)]'
                      : 'border-transparent hover:bg-white/[0.04]'
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold tabular-nums transition-colors ${
                      isActive
                        ? 'bg-accent text-bg-0'
                        : done
                          ? 'bg-[var(--accent-soft)] text-accent'
                          : 'bg-[var(--line-strong)] text-text-3'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span
                    className={`truncate text-[12px] font-medium ${
                      isActive ? 'text-text-1' : 'text-text-2'
                    }`}
                  >
                    {s.short}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Active step detail + linear nav. */}
          <div className="mt-3 flex items-end justify-between gap-4">
            <p className="min-h-[2.5rem] max-w-xl text-[12.5px] leading-relaxed text-text-2">
              {current.body}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {step > 0 && (
                <button
                  type="button"
                  onClick={prev}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:border-[var(--line-strong)] hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={next}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-bg-0 shadow-[0_0_22px_-8px_var(--accent-glow)] transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {isLast ? (
                  <>
                    Finish <LuCheck size={14} />
                  </>
                ) : (
                  <>
                    Next <LuChevronRight size={15} />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
