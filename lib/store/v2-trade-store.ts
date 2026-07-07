/**
 * lib/store/v2-trade-store.ts — shared trade selection for the v2 Trade screen,
 * bridging the market picker, the hero surface/smile, and the trade ticket
 * (mirrors the legacy surface-store role). Client-only Zustand.
 *
 * `strikeOffset` (binary) and the range band offsets are in admission-tick steps
 * from the at-the-money strike, so they stay meaningful as the forward moves and
 * across markets (reset on market switch). The ticket resolves them to actual
 * strikes against the live pricer.
 *
 * Range band offsets start null (uninitialized): a good default band width
 * depends on the market's IV/tenor (σ ≈ forward·IV·√T), so the ticket derives it
 * from the live pricer the first time range mode is used (see defaultRangeBand),
 * then the user adjusts it.
 */
import { create } from 'zustand';

export type V2TradeMode = 'binary' | 'range';

interface V2TradeState {
  marketId: string | null;
  mode: V2TradeMode;
  isUp: boolean;
  /** Strike steps from ATM (admission ticks); 0 = at-the-money. Binary. */
  strikeOffset: number;
  /** Range band edges, in admission-tick steps from ATM (null = uninitialized). */
  rangeLowerOffset: number | null;
  rangeHigherOffset: number | null;
  /** Amount the trader wants to pay (DUSDC). */
  stake: number;
  /** Leverage multiple (1 = none). */
  leverage: number;
  /** Bumped on every EXTERNAL pick (surface node click, market-card Up/Down) so
   *  the ticket can jump to its bet step — mirrors legacy's "a fresh surface/
   *  table/card pick jumps straight to step 2". Ticket-internal changes (slider
   *  drag, ± nudge, odds-curve drag) must NOT bump it. */
  pickSeq: number;

  selectMarket: (id: string) => void;
  setMode: (m: V2TradeMode) => void;
  setIsUp: (v: boolean) => void;
  nudgeStrike: (delta: number) => void;
  setStrikeOffset: (o: number) => void;
  setRangeBand: (lower: number, higher: number) => void;
  nudgeRangeEdge: (edge: 'lower' | 'higher', delta: number) => void;
  setStake: (s: number) => void;
  setLeverage: (l: number) => void;
  /** Mark the current selection as an external pick (see pickSeq). */
  markPicked: () => void;
}

export const useV2TradeStore = create<V2TradeState>((set) => ({
  marketId: null,
  mode: 'binary',
  isUp: true,
  strikeOffset: 0,
  rangeLowerOffset: null,
  rangeHigherOffset: null,
  stake: 10,
  leverage: 1,
  pickSeq: 0,

  // Switching markets resets strikes to ATM / a fresh band (offsets don't carry
  // across grids; the band re-derives from the new market's pricer).
  selectMarket: (marketId) => set({ marketId, strikeOffset: 0, rangeLowerOffset: null, rangeHigherOffset: null }),
  setMode: (mode) => set({ mode }),
  setIsUp: (isUp) => set({ isUp }),
  nudgeStrike: (delta) => set((s) => ({ strikeOffset: s.strikeOffset + delta })),
  setStrikeOffset: (strikeOffset) => set({ strikeOffset }),
  // Keep lower < higher by at least one step.
  setRangeBand: (lower, higher) =>
    set(lower < higher ? { rangeLowerOffset: lower, rangeHigherOffset: higher } : { rangeLowerOffset: higher, rangeHigherOffset: lower }),
  nudgeRangeEdge: (edge, delta) =>
    set((s) => {
      const lo = s.rangeLowerOffset ?? 0;
      const hi = s.rangeHigherOffset ?? 0;
      if (edge === 'lower') return { rangeLowerOffset: Math.min(lo + delta, hi - 1) };
      return { rangeHigherOffset: Math.max(hi + delta, lo + 1) };
    }),
  setStake: (stake) => set({ stake: Math.max(0, stake) }),
  setLeverage: (leverage) => set({ leverage: Math.max(1, leverage) }),
  markPicked: () => set((s) => ({ pickSeq: s.pickSeq + 1 })),
}));
