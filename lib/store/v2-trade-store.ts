/**
 * lib/store/v2-trade-store.ts — shared trade selection for the v2 Trade screen,
 * bridging the market picker, the hero smile, and the trade ticket (mirrors the
 * legacy surface-store role). Client-only Zustand.
 *
 * `strikeOffset` is in admission-tick steps from the at-the-money strike, so it
 * stays meaningful as the forward moves and across markets (reset on market
 * switch). The ticket resolves it to an actual strike against the live pricer.
 */
import { create } from 'zustand';

interface V2TradeState {
  marketId: string | null;
  isUp: boolean;
  /** Strike steps from ATM (admission ticks); 0 = at-the-money. */
  strikeOffset: number;
  /** Amount the trader wants to pay (DUSDC). */
  stake: number;
  /** Leverage multiple (1 = none). */
  leverage: number;

  selectMarket: (id: string) => void;
  setIsUp: (v: boolean) => void;
  nudgeStrike: (delta: number) => void;
  setStrikeOffset: (o: number) => void;
  setStake: (s: number) => void;
  setLeverage: (l: number) => void;
}

export const useV2TradeStore = create<V2TradeState>((set) => ({
  marketId: null,
  isUp: true,
  strikeOffset: 0,
  stake: 10,
  leverage: 1,

  // Switching markets resets the strike to ATM (offsets don't carry across grids).
  selectMarket: (marketId) => set({ marketId, strikeOffset: 0 }),
  setIsUp: (isUp) => set({ isUp }),
  nudgeStrike: (delta) => set((s) => ({ strikeOffset: s.strikeOffset + delta })),
  setStrikeOffset: (strikeOffset) => set({ strikeOffset }),
  setStake: (stake) => set({ stake: Math.max(0, stake) }),
  setLeverage: (leverage) => set({ leverage: Math.max(1, leverage) }),
}));
