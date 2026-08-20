'use client';

/**
 * lib/store/mobile-sheet-store — "a bottom sheet currently owns the mobile screen".
 *
 * The floating dock is `fixed` at z-50, so anything sliding up from the bottom edge is
 * painted over by it — the dock sat on top of the simple-mode bet drawer and swallowed
 * its confirm button. The dock already knows how to tuck itself away; it just needed a
 * signal that wasn't the advanced ticket's.
 *
 * Deliberately NOT `v2-trade-store.ticketSheetOpen`: that flag is wired into the whole
 * advanced flow (market cards, options, Kelly, copy-trade, the copilot ticket modal), so
 * borrowing it to hide the dock would pop the advanced ticket open as a side effect.
 * This is one boolean with exactly one meaning, so any sheet on any screen can raise it
 * without reaching into a feature's state.
 */
import { create } from 'zustand';

interface MobileSheetState {
  /** True while a full-width bottom sheet is open and the dock must stand down. */
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
}

export const useMobileSheetStore = create<MobileSheetState>((set) => ({
  sheetOpen: false,
  setSheetOpen: (open) => set({ sheetOpen: open }),
}));
