/**
 * lib/store/v2-trade-store.ts — shared trade selection for the v2 Trade screen,
 * bridging the market picker, the hero surface/smile, and the trade ticket
 * (mirrors the legacy surface-store role). Client-only Zustand.
 *
 * Strikes are stored as ABSOLUTE admission-grid prices (like legacy's
 * `strikeScaled`), NOT as offsets from the at-the-money price. A strike the user
 * picks is THEIR strike: it stays put as the forward moves, so the odds change
 * (correctly) but the level never chases the price. `null` means "not picked yet
 * — follow the current ATM", so a fresh market/ticket defaults to at-the-money
 * without pinning until the user actually chooses a level.
 *
 * Range band edges start null (no band): the user taps two price levels on the
 * odds curve (legacy parity — pickRangeLevel anchors on the first tap and closes
 * the band on the second), then drags the band edges to adjust.
 */
import { create } from 'zustand';

export type V2TradeMode = 'binary' | 'range';

interface V2TradeState {
  marketId: string | null;
  /** True when the user explicitly picked this market (tapped a row/card/surface
   *  node). Auto-advance follows the soonest market ONLY while this is false, so
   *  an untouched selection stays pinned to the top of the list instead of
   *  drifting down as newer, sooner markets open (legacy `selection ?? front`). */
  marketPinned: boolean;
  mode: V2TradeMode;
  isUp: boolean;
  /** Absolute binary strike (admission-grid price). null = follow ATM until picked. */
  strikePrice: number | null;
  /** Absolute range band edges (admission-grid prices). null = no band yet. */
  rangeLowerPrice: number | null;
  rangeHigherPrice: number | null;
  /** First tapped absolute level while building a band (null once the band is set). */
  rangeAnchorPrice: number | null;
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
  /** A "find / point me to this strike" request (co-pilot) the surface REVEALS:
   *  it pauses the idle spin, eases the camera onto the strike, and flashes the
   *  marker so the found level is unmistakable. Distinct from `fill` (a mint
   *  ripple). `ts` distinguishes repeat finds of the same node. */
  focus: { marketId: string; strike: number; isUp: boolean; ts: number } | null;

  /** Mobile only: whether the slide-up trade-ticket sheet is open. Picking any
   *  market (table row / card side) opens it; desktop ignores it (the ticket
   *  lives in the always-visible right rail there). Mirrors surface-store. */
  ticketSheetOpen: boolean;

  /** Select a market. `pinned` defaults to true (an explicit user pick); the
   *  auto-advancer passes false so its selections keep tracking the soonest. */
  selectMarket: (id: string, pinned?: boolean) => void;
  setMode: (m: V2TradeMode) => void;
  setIsUp: (v: boolean) => void;
  /** Pin an absolute binary strike (admission-grid price). */
  setStrikePrice: (price: number) => void;
  /** Set both band edges to absolute prices (sorted). */
  setRangeBand: (lower: number, higher: number) => void;
  /** Tap-two-prices band building (legacy parity): the first pick anchors, the
   *  second closes the band (sorted); a pick with a band already set re-anchors.
   *  All in absolute admission-grid prices. */
  pickRangeLevel: (price: number) => void;
  clearRange: () => void;
  setStake: (s: number) => void;
  setLeverage: (l: number) => void;
  /** Mark the current selection as an external pick (see pickSeq). */
  markPicked: () => void;
  /** Announce a successful mint so the surface can ripple at the fill. */
  pulseFill: (f: { marketId: string; strike: number; isUp: boolean }) => void;
  /** Ask the surface to reveal a strike (pause spin, ease camera in, flash it) —
   *  used when the co-pilot finds/points to a level so it clearly "lands". */
  pulseFocus: (f: { marketId: string; strike: number; isUp: boolean }) => void;
  /** Mobile: open / close the slide-up trade-ticket sheet. */
  openTicketSheet: () => void;
  closeTicketSheet: () => void;
}

export const useV2TradeStore = create<V2TradeState>((set) => ({
  marketId: null,
  marketPinned: false,
  mode: 'binary',
  isUp: true,
  strikePrice: null,
  rangeLowerPrice: null,
  rangeHigherPrice: null,
  rangeAnchorPrice: null,
  stake: 10,
  leverage: 1,
  pickSeq: 0,
  fill: null,
  focus: null,
  ticketSheetOpen: false,

  // Switching markets drops the pinned strike/band (a $63k strike is meaningless
  // on a different expiry's grid); the new market defaults to its own ATM until
  // the user picks a level.
  selectMarket: (marketId, pinned = true) =>
    set({ marketId, marketPinned: pinned, strikePrice: null, rangeLowerPrice: null, rangeHigherPrice: null, rangeAnchorPrice: null }),
  // Leaving range mode abandons a half-built band (legacy setTicketMode parity).
  setMode: (mode) => set(mode === 'binary' ? { mode, rangeAnchorPrice: null } : { mode }),
  setIsUp: (isUp) => set({ isUp }),
  setStrikePrice: (strikePrice) => set({ strikePrice }),
  // Keep lower < higher.
  setRangeBand: (lower, higher) =>
    set(
      lower < higher
        ? { rangeLowerPrice: lower, rangeHigherPrice: higher, rangeAnchorPrice: null }
        : { rangeLowerPrice: higher, rangeHigherPrice: lower, rangeAnchorPrice: null },
    ),
  pickRangeLevel: (price) =>
    set((s) => {
      // No pick in progress (fresh start, or a tap away from an existing band's
      // edges) → anchor here and clear any previous band.
      if (s.rangeAnchorPrice == null) {
        return { rangeAnchorPrice: price, rangeLowerPrice: null, rangeHigherPrice: null };
      }
      if (price === s.rangeAnchorPrice) return {}; // same level — ignore
      return {
        rangeAnchorPrice: null,
        rangeLowerPrice: Math.min(s.rangeAnchorPrice, price),
        rangeHigherPrice: Math.max(s.rangeAnchorPrice, price),
      };
    }),
  clearRange: () => set({ rangeAnchorPrice: null, rangeLowerPrice: null, rangeHigherPrice: null }),
  setStake: (stake) => set({ stake: Math.max(0, stake) }),
  setLeverage: (leverage) => set({ leverage: Math.max(1, leverage) }),
  markPicked: () => set((s) => ({ pickSeq: s.pickSeq + 1 })),
  pulseFill: (f) => set({ fill: { ...f, ts: Date.now() } }),
  pulseFocus: (f) => set({ focus: { ...f, ts: Date.now() } }),
  openTicketSheet: () => set({ ticketSheetOpen: true }),
  closeTicketSheet: () => set({ ticketSheetOpen: false }),
}));
