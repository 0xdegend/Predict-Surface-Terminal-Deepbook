/**
 * lib/store/surface-store.ts — shared UI state bridging the surface controls,
 * the canvas, and (Phase 4) the trade ticket. Zustand, client-only.
 */
import { create } from 'zustand';

export type SurfaceMode = 'live' | 'scrub';

export interface SurfaceSelection {
  oracleId: string;
  expiry: number;
  /** 1e9-scaled strike as a string (bigint isn't serializable in some paths). */
  strikeScaled: string;
  strike: number; // float, for display
  isUp: boolean;
}

interface SurfaceState {
  mode: SurfaceMode;
  /** Scrub position 0..1 over the history window (1 = newest). */
  scrub: number;
  showNoArb: boolean;
  /** 0 = off; >0 perturbs SVI to make the no-arb checker fire (demo). */
  stress: number;

  selection: SurfaceSelection | null;

  /** Last confirmed mint — drives the fill ripple on the surface. */
  fill: { oracleId: string; strike: number; isUp: boolean; ts: number } | null;

  setMode: (mode: SurfaceMode) => void;
  setScrub: (scrub: number) => void; // also flips to scrub mode
  goLive: () => void;
  toggleNoArb: () => void;
  setStress: (stress: number) => void;
  select: (sel: SurfaceSelection | null) => void;
  pulseFill: (f: { oracleId: string; strike: number; isUp: boolean }) => void;
}

export const useSurfaceStore = create<SurfaceState>((set) => ({
  mode: 'live',
  scrub: 1,
  showNoArb: false,
  stress: 0,
  selection: null,
  fill: null,

  setMode: (mode) => set({ mode }),
  setScrub: (scrub) => set({ scrub: Math.max(0, Math.min(1, scrub)), mode: 'scrub' }),
  goLive: () => set({ mode: 'live', scrub: 1 }),
  toggleNoArb: () => set((s) => ({ showNoArb: !s.showNoArb })),
  setStress: (stress) => set({ stress: Math.max(0, Math.min(1, stress)) }),
  select: (selection) => set({ selection }),
  pulseFill: (f) => set({ fill: { ...f, ts: Date.now() } }),
}));
