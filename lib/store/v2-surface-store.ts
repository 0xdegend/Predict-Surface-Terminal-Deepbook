'use client';

/**
 * v2 surface view state — LIVE vs time-travel scrub. Kept separate from
 * useV2TradeStore (which owns the trade selection) because this is purely how the
 * surface is being *viewed*, not what is being traded. Mirrors the legacy
 * surface-store's mode/scrub pair so the controls port across unchanged.
 */
import { create } from 'zustand';

export type V2SurfaceMode = 'live' | 'scrub';

interface V2SurfaceState {
  mode: V2SurfaceMode;
  /**
   * Where the SLIDER is, 0 = oldest … 1 = newest. This is a *target*: the surface
   * eases toward it (useSmoothScrub), so a fast fling can't throw the 3-D around.
   */
  scrub: number;
  /** True while gliding home to the live stream — committed once the surface lands. */
  pendingLive: boolean;
  /**
   * Bumped each time we LEAVE the live stream. The IV ruler is frozen per session:
   * the tape keeps recording while you rewind, and re-deriving the ruler off a
   * growing tape shifted the scale under the surface every few seconds, so the whole
   * model visibly rose and then settled. The window you entered with is the window
   * you rewind through — the ruler should be too.
   */
  scrubSession: number;
  /** Drag the slider — always implies leaving the live stream. */
  setScrub: (v: number) => void;
  /**
   * Ask to return to live. Rather than cutting instantly (which would jump the
   * surface mid-motion), this aims the follower at the newest frame; the surface
   * glides there and `goLive` commits on arrival.
   */
  requestLive: () => void;
  /** Commit the switch to the streaming surface. */
  goLive: () => void;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const useV2SurfaceStore = create<V2SurfaceState>((set) => ({
  mode: 'live',
  scrub: 1,
  pendingLive: false,
  scrubSession: 0,
  setScrub: (v) =>
    set((s) => ({
      scrub: clamp01(v),
      mode: 'scrub',
      pendingLive: false,
      // A new session only on the live → scrub transition, not on every drag frame.
      scrubSession: s.mode === 'live' ? s.scrubSession + 1 : s.scrubSession,
    })),
  requestLive: () =>
    set((s) => (s.mode === 'live' ? { scrub: 1, pendingLive: false } : { scrub: 1, pendingLive: true })),
  goLive: () => set({ mode: 'live', scrub: 1, pendingLive: false }),
}));
