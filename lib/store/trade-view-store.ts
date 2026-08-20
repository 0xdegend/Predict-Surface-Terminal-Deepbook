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
  /**
   * Whether this browser has answered the first-visit experience prompt.
   *
   * Separate from `view` because "defaulted to simple" and "told us they're a beginner"
   * are different facts, and only the second one should stop us asking. It lives HERE
   * rather than in the modal so the guided tour can read it too — both fire on landing
   * at /v2, and the tour must not start underneath an unanswered dialog.
   */
  chosen: boolean;
  /** Answer the prompt: remember the view AND that the question was asked. */
  choose: (v: TradeView) => void;
  /** Test/QA helper — re-arms the prompt for this browser. */
  resetChoice: () => void;
}

export const useTradeViewStore = create<TradeViewState>()(
  persist(
    (set) => ({
      view: 'simple',
      setView: (view) => set({ view }),
      chosen: false,
      choose: (view) => set({ view, chosen: true }),
      resetChoice: () => set({ chosen: false }),
    }),
    {
      name: 'skew.tradeView',
      storage: createJSONStorage(() => localStorage),
      // Only the facts, not the actions. Traders who used the toggle before the prompt
      // existed have a stored `view` but no `chosen`, so it falls back to the initial
      // `false` and they get asked once — which is correct: they never were.
      partialize: (s) => ({ view: s.view, chosen: s.chosen }) as TradeViewState,
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
