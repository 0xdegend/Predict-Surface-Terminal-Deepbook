'use client';

import { useRef } from 'react';
import gsap from 'gsap';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { timeUTC } from '@/lib/format';
import { InfoTip } from '@/app/_components/ui/info-tip';

/**
 * Floating glass control bar (redesign Phase 2). Sits lifted off the canvas as
 * the surface's only chrome: a LIVE snap-pill + time-travel scrub on the left,
 * and a segmented overlay group (no-arb / stress) on the right. The scrub is the
 * signature interaction — dragging morphs the surface through SVI history; LIVE
 * snaps smoothly back to the stream.
 */
export function SurfaceControls({
  isLive,
  currentTime,
  historyReady,
}: {
  isLive: boolean;
  currentTime: number;
  historyReady: boolean;
}) {
  const scrub = useSurfaceStore((s) => s.scrub);
  const setScrub = useSurfaceStore((s) => s.setScrub);
  const goLive = useSurfaceStore((s) => s.goLive);
  const showNoArb = useSurfaceStore((s) => s.showNoArb);
  const toggleNoArb = useSurfaceStore((s) => s.toggleNoArb);
  const stress = useSurfaceStore((s) => s.stress);
  const setStress = useSurfaceStore((s) => s.setStress);

  const tweenRef = useRef<gsap.core.Tween | null>(null);

  function snapToLive() {
    tweenRef.current?.kill();
    const proxy = { v: scrub };
    tweenRef.current = gsap.to(proxy, {
      v: 1,
      duration: 0.55,
      ease: 'power3.out',
      onUpdate: () => setScrub(proxy.v),
      onComplete: () => goLive(),
    });
  }

  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-xl p-1.5 shadow-[0_16px_44px_-12px_rgba(0,0,0,0.7)] glass sm:bottom-5 sm:flex-nowrap">
      {/* LIVE snap-pill */}
      <button
        onClick={snapToLive}
        className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[11px] font-medium uppercase tracking-wider transition-colors ${
          isLive
            ? 'bg-[var(--accent-soft)] text-accent'
            : 'text-text-3 hover:bg-white/[0.04] hover:text-text-2'
        }`}
      >
        Live
      </button>

      {/* Scrub group */}
      <div className="flex items-center gap-2 px-1 sm:gap-2.5 sm:px-2">
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={scrub}
          disabled={!historyReady}
          onChange={(e) => setScrub(Number(e.target.value))}
          className="surface-scrub h-1 w-32 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 sm:w-52"
          aria-label="Time-travel scrub"
        />
        <span className="w-16 text-center font-mono text-[10px] tabular-nums text-text-2 whitespace-nowrap sm:w-20">
          {isLive ? 'now' : timeUTC(currentTime)}
        </span>
      </div>

      {/* Segmented overlay toggles — desktop only. On phones they pushed the bar
          into a tall 3-row box over the surface; the no-arb / stress checks are
          niche demo overlays, so the mobile bar keeps just the time-travel. The
          trailing "?" explains both overlays in plain language. */}
      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--bg-3)] p-0.5">
          <SegToggle active={showNoArb} onClick={toggleNoArb} tone="accent">
            No-arb
          </SegToggle>
          <SegToggle active={stress > 0} onClick={() => setStress(stress > 0 ? 0 : 0.6)} tone="down">
            Stress
          </SegToggle>
        </div>
        <InfoTip label="the surface overlays" size={13}>
          <span className="block">
            <span className="font-medium text-accent">No-arb</span> — checks the live surface for
            prices that can’t logically coexist (a cheaper option paying out more than a pricier
            one). Toggle it on and any offending strikes flash on the surface; clean data shows
            nothing.
          </span>
          <span className="mt-2 block">
            <span className="font-medium text-down">Stress</span> — deliberately bends the smile to
            push the surface out of shape, making the no-arb check fire on demand. Turn both on to
            watch it catch the break, then off to return to live pricing.
          </span>
        </InfoTip>
      </div>
    </div>
  );
}

function SegToggle({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'accent' | 'down';
  children: React.ReactNode;
}) {
  const activeCls =
    tone === 'down'
      ? 'bg-[var(--down-soft)] text-down'
      : 'bg-[var(--accent-soft)] text-accent';
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`h-7 whitespace-nowrap rounded-md px-2.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
        active ? activeCls : 'text-text-3 hover:text-text-2'
      }`}
    >
      {children}
    </button>
  );
}
