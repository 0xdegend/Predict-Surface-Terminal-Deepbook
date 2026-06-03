'use client';

import { useRef } from 'react';
import gsap from 'gsap';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { timeUTC } from '@/lib/format';

/**
 * Surface control bar: time-travel scrub (GSAP-snapped LIVE), no-arb overlay,
 * and the demo stress toggle. The scrub is the signature interaction — dragging
 * morphs the surface through SVI history; LIVE snaps smoothly back to the stream.
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
    <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-bg-1/90 px-3 py-2 backdrop-blur">
      <button
        onClick={snapToLive}
        className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wider ${
          isLive ? 'text-up' : 'text-text-3 hover:text-text-2'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'animate-pulse bg-up' : 'bg-text-3'}`} />
        Live
      </button>

      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={scrub}
        disabled={!historyReady}
        onChange={(e) => setScrub(Number(e.target.value))}
        className="h-1 w-56 cursor-pointer appearance-none rounded-full bg-bg-3 accent-[var(--up)] disabled:opacity-40"
        aria-label="Time-travel scrub"
      />

      <span className="w-16 text-center font-mono text-[10px] tabular-nums text-text-2">
        {isLive ? 'now' : timeUTC(currentTime)}
      </span>

      <div className="mx-1 h-5 w-px bg-line" />

      <button
        onClick={toggleNoArb}
        className={`rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wider ${
          showNoArb ? 'text-text-1' : 'text-text-3 hover:text-text-2'
        }`}
      >
        no-arb
      </button>

      <button
        onClick={() => setStress(stress > 0 ? 0 : 0.6)}
        className={`rounded px-2 py-1 font-mono text-[11px] uppercase tracking-wider ${
          stress > 0 ? 'text-down' : 'text-text-3 hover:text-text-2'
        }`}
      >
        stress
      </button>
    </div>
  );
}
