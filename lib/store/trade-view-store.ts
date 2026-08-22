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
 *
 * Every write is MIRRORED INTO A COOKIE. The server decides where a phone lands (see
 * `shouldLandOnSimple`) and cannot read localStorage, so the cookie is how an explicit
 * "I want Advanced" reaches it. Writing it here, in the one place the view changes, is
 * what keeps the two from drifting.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { TRADE_VIEW_COOKIE, type TradeView } from './trade-view';

export * from './trade-view';

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Mirror the view where the server can see it. Best-effort: a browser that refuses
 *  cookies just keeps the client-side behaviour it has always had. */
function mirrorToCookie(view: TradeView) {
  try {
    document.cookie = `${TRADE_VIEW_COOKIE}=${view}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  } catch {
    /* no document (SSR) or storage blocked — the store is still the client's truth */
  }
}

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
  /**
   * Whether the returning-trader "simple mode is live" note has been seen off. Lives
   * beside `chosen` because they are two halves of one decision: a browser gets the
   * dialog OR the note, never both, and either one answers the question for good.
   */
  noticeSeen: boolean;
  seeNotice: () => void;
  /** Test/QA helper — re-arms the prompt AND the note for this browser. */
  resetChoice: () => void;
}

export const useTradeViewStore = create<TradeViewState>()(
  persist(
    (set) => ({
      view: 'simple',
      setView: (view) => {
        mirrorToCookie(view);
        set({ view });
      },
      chosen: false,
      choose: (view) => {
        mirrorToCookie(view);
        set({ view, chosen: true });
      },
      noticeSeen: false,
      seeNotice: () => set({ noticeSeen: true }),
      resetChoice: () => set({ chosen: false, noticeSeen: false }),
    }),
    {
      name: 'skew.tradeView',
      storage: createJSONStorage(() => localStorage),
      // Only the facts, not the actions. Traders who used the toggle before the prompt
      // existed have a stored `view` but no `chosen`, so it falls back to the initial
      // `false` and they get asked once — which is correct: they never were.
      partialize: (s) => ({ view: s.view, chosen: s.chosen, noticeSeen: s.noticeSeen }) as TradeViewState,
      // Self-heal: browsers that chose a view BEFORE the cookie existed only have it in
      // localStorage, so publish it once on rehydrate. Without this a phone carrying an
      // old 'advanced' would be sent to simple on every cold load.
      onRehydrateStorage: () => (state) => {
        if (state) mirrorToCookie(state.view);
      },
    },
  ),
);
