/**
 * lib/store/deployment-store.ts — which protocol deployment the app is pointed at.
 *
 *   'legacy' = the original (frozen) Predict deployment + old server. Kept fully
 *              functional so users can keep trading / claiming until DeepBook's
 *              old oracles stop ticking.
 *   'v2'     = the new predict-testnet-6-24 redesign (account model, ExpiryMarket,
 *              leverage, async PLP, beta server).
 *
 * Persisted to localStorage so a user's choice survives reloads (like the
 * card/table view pref). While V2_READY is false the store is pinned to 'legacy'
 * so a stale persisted 'v2' can never strand someone in a half-built path.
 *
 * Client-only. Components must read it behind a mounted guard (see useMounted)
 * to avoid SSR hydration mismatch — the server always renders the default.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { type Deployment, V2_READY, v2Deployed } from '@/config/predict';

/** Latest is selectable only once the v2 layer is built AND wired for this network. */
export const v2Selectable = V2_READY && v2Deployed;

interface DeploymentState {
  deployment: Deployment;
  setDeployment: (d: Deployment) => void;
  toggle: () => void;
}

export const useDeploymentStore = create<DeploymentState>()(
  persist(
    (set, get) => ({
      deployment: 'legacy',
      setDeployment: (deployment) =>
        // Guard: refuse to switch to v2 until it's selectable.
        set({ deployment: deployment === 'v2' && !v2Selectable ? 'legacy' : deployment }),
      toggle: () => get().setDeployment(get().deployment === 'legacy' ? 'v2' : 'legacy'),
    }),
    {
      name: 'skew.deployment',
      storage: createJSONStorage(() => localStorage),
      // Coerce any persisted 'v2' back to 'legacy' while v2 isn't selectable.
      merge: (persisted, current) => {
        const p = persisted as Partial<DeploymentState> | undefined;
        const want = p?.deployment === 'v2' && v2Selectable ? 'v2' : 'legacy';
        return { ...current, deployment: want };
      },
    },
  ),
);
