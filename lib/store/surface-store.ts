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

/** Which trade ticket the right rail shows. */
export type TicketMode = 'binary' | 'range';

/** A single strike pick (anchor of a range band, or a binary). */
export interface StrikePick {
  oracleId: string;
  expiry: number;
  strikeScaled: string; // 1e9-scaled
  strike: number; // float
}

/** A finalized vertical-range band: pays $1 if settlement ∈ (lower, higher]. */
export interface RangeSelection {
  oracleId: string;
  expiry: number;
  lowerScaled: string; // 1e9-scaled
  higherScaled: string;
  lower: number; // float, for display
  higher: number; // float
}

interface SurfaceState {
  mode: SurfaceMode;
  /** Scrub position 0..1 over the history window (1 = newest). */
  scrub: number;
  showNoArb: boolean;
  /** 0 = off; >0 perturbs SVI to make the no-arb checker fire (demo). */
  stress: number;

  selection: SurfaceSelection | null;

  /** Binary vs vertical-range ticket. */
  ticketMode: TicketMode;
  /** First strike of a range band, awaiting the second click. */
  rangeAnchor: StrikePick | null;
  /** The finalized band (both strikes picked). */
  rangeSelection: RangeSelection | null;

  /** Last confirmed mint — drives the fill ripple on the surface. */
  fill: { oracleId: string; strike: number; isUp: boolean; ts: number } | null;

  setMode: (mode: SurfaceMode) => void;
  setScrub: (scrub: number) => void; // also flips to scrub mode
  goLive: () => void;
  toggleNoArb: () => void;
  setStress: (stress: number) => void;
  select: (sel: SurfaceSelection | null) => void;
  setTicketMode: (mode: TicketMode) => void;
  /** Add a strike to the range band: 1st click anchors, 2nd forms the band
   *  (sorted lower/higher). A click on a different oracle/expiry re-anchors. */
  pickRangeStrike: (s: StrikePick) => void;
  clearRange: () => void;
  pulseFill: (f: { oracleId: string; strike: number; isUp: boolean }) => void;
}

export const useSurfaceStore = create<SurfaceState>((set) => ({
  mode: 'live',
  scrub: 1,
  showNoArb: false,
  stress: 0,
  selection: null,
  ticketMode: 'binary',
  rangeAnchor: null,
  rangeSelection: null,
  fill: null,

  setMode: (mode) => set({ mode }),
  setScrub: (scrub) => set({ scrub: Math.max(0, Math.min(1, scrub)), mode: 'scrub' }),
  goLive: () => set({ mode: 'live', scrub: 1 }),
  toggleNoArb: () => set((s) => ({ showNoArb: !s.showNoArb })),
  setStress: (stress) => set({ stress: Math.max(0, Math.min(1, stress)) }),
  select: (selection) => set({ selection }),
  setTicketMode: (ticketMode) =>
    set(ticketMode === 'binary' ? { ticketMode, rangeAnchor: null } : { ticketMode }),
  pickRangeStrike: (s) =>
    set((state) => {
      const a = state.rangeAnchor;
      // Start (or restart) the band if there's no anchor, or it's on a different market.
      if (!a || a.oracleId !== s.oracleId || a.expiry !== s.expiry) {
        return { ticketMode: 'range', rangeAnchor: s, rangeSelection: null };
      }
      if (s.strikeScaled === a.strikeScaled) return {}; // same node — ignore
      const [lo, hi] = a.strike < s.strike ? [a, s] : [s, a];
      return {
        ticketMode: 'range',
        rangeAnchor: null,
        rangeSelection: {
          oracleId: s.oracleId,
          expiry: s.expiry,
          lowerScaled: lo.strikeScaled,
          higherScaled: hi.strikeScaled,
          lower: lo.strike,
          higher: hi.strike,
        },
      };
    }),
  clearRange: () => set({ rangeAnchor: null, rangeSelection: null }),
  pulseFill: (f) => set({ fill: { ...f, ts: Date.now() } }),
}));
