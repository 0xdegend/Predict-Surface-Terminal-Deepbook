'use client';

/**
 * Product-tour store. A tiny zustand store driving the first-visit guided tour
 * (the spotlight + glass popover wizard). Kept imperative so the launcher
 * (first-visit detection) and the replay button can both kick it off without
 * prop-drilling, mirroring the toast-store pattern. <TourOverlay /> subscribes
 * and owns all the positioning/rendering; this only holds open/closed + index.
 */
import { create } from 'zustand';

interface TourState {
  /** Is the tour currently running? */
  active: boolean;
  /** Index into the (runtime-filtered) visible step list. */
  step: number;
  /** Open the tour from the top. */
  start: () => void;
  /** Close the tour (overlay handles persisting "seen"). */
  stop: () => void;
  setStep: (step: number) => void;
}

export const useTourStore = create<TourState>((set) => ({
  active: false,
  step: 0,
  start: () => set({ active: true, step: 0 }),
  stop: () => set({ active: false }),
  setStep: (step) => set({ step }),
}));
