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
 * Range band offsets start null (no band): the user taps two price levels on
 * the odds curve (legacy parity — pickRangeOffset anchors on the first tap and
 * closes the band on the second), then drags the band edges to adjust.
 */
import { create } from 'zustand';

export type V2TradeMode = 'binary' | 'range';

interface V2TradeState {
  marketId: string | null;
  mode: V2TradeMode;
  isUp: boolean;
  /** Strike steps from ATM (admission ticks); 0 = at-the-money. Binary. */
  strikeOffset: number;
  /** Range band edges, in admission-tick steps from ATM (null = no band yet). */
  rangeLowerOffset: number | null;
  rangeHigherOffset: number | null;
  /** First tapped range level while building a band (null once the band is set). */
  rangeAnchorOffset: number | null;
  /** Amount the trader wants to pay (DUSDC). */
  stake: number;
  /** Leverage multiple (1 = none). */
  leverage: number;
  /** Bumped on every EXTERNAL pick (surface node click, market-card Up/Down) so
   *  the ticket can jump to its bet step — mirrors legacy's "a fresh surface/
   *  table/card pick jumps straight to step 2". Ticket-internal changes (slider
   *  drag, ± nudge, odds-curve drag) must NOT bump it. */
  pickSeq: number;
  /** Last successful mint (legacy surface-store parity) — the surface pulses a
   *  ripple at this spot. `ts` distinguishes repeat fills at the same node. */
  fill: { marketId: string; strike: number; isUp: boolean; ts: number } | null;

  selectMarket: (id: string) => void;
  setMode: (m: V2TradeMode) => void;
  setIsUp: (v: boolean) => void;
  nudgeStrike: (delta: number) => void;
  setStrikeOffset: (o: number) => void;
  setRangeBand: (lower: number, higher: number) => void;
  /** Tap-two-prices band building (legacy parity): the first pick anchors, the
   *  second closes the band (sorted); a pick with a band already set re-anchors. */
  pickRangeOffset: (offset: number) => void;
  clearRange: () => void;
  setStake: (s: number) => void;
  setLeverage: (l: number) => void;
  /** Mark the current selection as an external pick (see pickSeq). */
  markPicked: () => void;
  /** Announce a successful mint so the surface can ripple at the fill. */
  pulseFill: (f: { marketId: string; strike: number; isUp: boolean }) => void;
}

export const useV2TradeStore = create<V2TradeState>((set) => ({
  marketId: null,
  mode: 'binary',
  isUp: true,
  strikeOffset: 0,
  rangeLowerOffset: null,
  rangeHigherOffset: null,
  rangeAnchorOffset: null,
  stake: 10,
  leverage: 1,
  pickSeq: 0,
  fill: null,

  // Switching markets resets strikes to ATM and drops any band/anchor (offsets
  // don't carry across grids — the user re-picks on the new market's curve).
  selectMarket: (marketId) =>
    set({ marketId, strikeOffset: 0, rangeLowerOffset: null, rangeHigherOffset: null, rangeAnchorOffset: null }),
  // Leaving range mode abandons a half-built band (legacy setTicketMode parity).
  setMode: (mode) => set(mode === 'binary' ? { mode, rangeAnchorOffset: null } : { mode }),
  setIsUp: (isUp) => set({ isUp }),
  nudgeStrike: (delta) => set((s) => ({ strikeOffset: s.strikeOffset + delta })),
  setStrikeOffset: (strikeOffset) => set({ strikeOffset }),
  // Keep lower < higher by at least one step.
  setRangeBand: (lower, higher) =>
    set(
      lower < higher
        ? { rangeLowerOffset: lower, rangeHigherOffset: higher, rangeAnchorOffset: null }
        : { rangeLowerOffset: higher, rangeHigherOffset: lower, rangeAnchorOffset: null },
    ),
  pickRangeOffset: (offset) =>
    set((s) => {
      // No pick in progress (fresh start, or a tap away from an existing band's
      // edges) → anchor here and clear any previous band.
      if (s.rangeAnchorOffset == null) {
        return { rangeAnchorOffset: offset, rangeLowerOffset: null, rangeHigherOffset: null };
      }
      if (offset === s.rangeAnchorOffset) return {}; // same level — ignore
      return {
        rangeAnchorOffset: null,
        rangeLowerOffset: Math.min(s.rangeAnchorOffset, offset),
        rangeHigherOffset: Math.max(s.rangeAnchorOffset, offset),
      };
    }),
  clearRange: () => set({ rangeAnchorOffset: null, rangeLowerOffset: null, rangeHigherOffset: null }),
  setStake: (stake) => set({ stake: Math.max(0, stake) }),
  setLeverage: (leverage) => set({ leverage: Math.max(1, leverage) }),
  markPicked: () => set((s) => ({ pickSeq: s.pickSeq + 1 })),
  pulseFill: (f) => set({ fill: { ...f, ts: Date.now() } }),
}));
