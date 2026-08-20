'use client';

/**
 * Product-tour store. A tiny zustand store driving the guided tours (the spotlight +
 * bottom-stepper wizard). Kept imperative so the launcher (first-visit detection), the
 * "?" menu, and the ticket empty-state can all kick a tour off without prop-drilling,
 * mirroring the toast-store pattern. <TourOverlay /> subscribes and owns all the
 * positioning/rendering; this only holds which tour + open/closed + index.
 */
import { create } from 'zustand';
import { type TourId, DEFAULT_TOUR } from '@/lib/tour/steps';

interface TourState {
  /** Is a tour currently running? */
  active: boolean;
  /** Which tour is running. */
  tour: TourId;
  /** Index into the (runtime-filtered) visible step list. */
  step: number;
  /** Open a tour from the top (defaults to the orientation tour). */
  start: (tour?: TourId) => void;
  /** Close the tour (overlay handles persisting "seen"). */
  stop: () => void;
  setStep: (step: number) => void;
}

export const useTourStore = create<TourState>((set) => ({
  active: false,
  tour: DEFAULT_TOUR,
  step: 0,
  start: (tour = DEFAULT_TOUR) => set({ active: true, tour, step: 0 }),
  stop: () => set({ active: false }),
  setStep: (step) => set({ step }),
}));
