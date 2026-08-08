/**
 * lib/store/session-prefs-store.ts — local UI preferences for delegated trading
 * sessions ([[sessions-delegated-trading]]). Client-only, persisted to localStorage.
 *
 * `armInstant` = the opt-in intent to turn instant trading ON with the next trade:
 * when it's set and no session is live, that trade's owner-signed approval also bundles
 * `authorize_session` + a gas top-up, so one approval sets up popup-less trading. Off
 * by default; every bundle is disclosed in the confirm modal, so it's never silent.
 * `sessionDuration` = how long that session lasts (24h default).
 *
 * `instantTrade` = the opt-in "one-tap" mode: with a live session, skip our own review
 * modal and place the trade straight away. Off by default; only takes effect when a
 * session is live AND the trade needs no wallet top-up, so a one-tap can never silently
 * trigger a deposit pop-up.
 *
 * All three are purely UI preferences — they change nothing on-chain and grant no new
 * authority on their own (the authorize itself is always an explicit, signed approval).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SESSION_DURATION, type SessionDuration } from '@/lib/sui/v2/session';

interface SessionPrefsState {
  armInstant: boolean;
  setArmInstant: (v: boolean) => void;
  sessionDuration: SessionDuration;
  setSessionDuration: (d: SessionDuration) => void;
  instantTrade: boolean;
  setInstantTrade: (v: boolean) => void;
}

export const useSessionPrefs = create<SessionPrefsState>()(
  persist(
    (set) => ({
      armInstant: false,
      setArmInstant: (armInstant) => set({ armInstant }),
      sessionDuration: DEFAULT_SESSION_DURATION,
      setSessionDuration: (sessionDuration) => set({ sessionDuration }),
      instantTrade: false,
      setInstantTrade: (instantTrade) => set({ instantTrade }),
    }),
    { name: 'skew:session-prefs' },
  ),
);
