'use client';

/**
 * lib/store/trade-view-store.ts — which trade experience the Trade tab opens:
 * 'simple' (the /v2/simple round view) or 'advanced' (the full /v2 terminal).
 *
 * Persisted so a returning trader reopens their last-used view, and defaults to
 * 'simple' so first-time visitors land on the calm screen (per the simple-mode
 * brief). Only meaningful when V2_SIMPLE_ENABLED — `tradeHref` falls back to the
 * full terminal when the flag is off, so the toggle and this store are inert
 * until we turn simple mode on.
 *
 * Client-only. Nav hrefs read it behind a mounted guard (the server always
 * renders the default) so a persisted 'advanced' can't cause an SSR href
 * mismatch. See [[simple-mode]].
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type TradeView = 'simple' | 'advanced';

interface TradeViewState {
  view: TradeView;
  setView: (v: TradeView) => void;
}

export const useTradeViewStore = create<TradeViewState>()(
  persist(
    (set) => ({
      view: 'simple',
      setView: (view) => set({ view }),
    }),
    {
      name: 'skew.tradeView',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** The Trade-tab href for a remembered view, honoring the feature flag. */
export function tradeHref(view: TradeView, simpleEnabled: boolean): string {
  return simpleEnabled && view === 'simple' ? '/v2/simple' : '/v2';
}

/** True when a pathname is either trade screen (advanced `/v2` or `/v2/simple`). */
export function isTradeRoute(pathname: string): boolean {
  return pathname === '/v2' || pathname.startsWith('/v2/simple');
}
