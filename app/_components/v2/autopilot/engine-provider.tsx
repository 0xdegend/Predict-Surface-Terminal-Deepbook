'use client';

/**
 * AutopilotEngineProvider — keeps a live Autopilot run running anywhere on /v2.
 *
 * The engine used to be called inside the Autopilot panel, which made a live run a
 * property of one screen. Opening the Trade page unmounted the panel, the 6s loop's
 * interval was cleared, and the run stopped placing trades, scoring settlements and
 * counting down. Coming back was worse than leaving: the remount re-ran the store's
 * rehydrate, and the reload guard (`_resumeAfterReload`) landed the still-armed run as
 * stopped and logged it as a page reload that had never happened.
 *
 * So the engine moved up here, into the /v2 layout, which survives every navigation
 * inside the app. Three things follow from that:
 *
 *   1. The store is rehydrated ONCE per page load, behind a module-level guard, so only
 *      a real reload can trip the safety rule that a run never resumes on its own.
 *   2. The engine host is mounted as a SIBLING of the page, never a parent, so turning
 *      it on or off cannot remount whatever the trader is looking at.
 *   3. It is mounted only when it has work to do (see lib/autopilot/engine-gate), so
 *      nobody reading the leaderboard pays for a market, pricer and spot poll they will
 *      never look at.
 *
 * The account lives here too, deliberately. Arming (owner-signed) and firing (session-
 * signed) must share ONE usePredictAccountV2 instance or they get separate in-flight
 * locks and can overlap, so the panel and the engine both read this one off the context.
 * It costs nothing extra: the v2 chrome's wallet bar already mounts the same hook on
 * every page, and its queries dedupe on their keys.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useAutopilotEngine, type AutopilotEngineView } from '@/lib/hooks/use-autopilot-engine';
import { useAutopilotStore } from '@/lib/store/autopilot-store';
import { engineShouldRun } from '@/lib/autopilot/engine-gate';
import { RunPill } from './run-pill';

type Acct = ReturnType<typeof usePredictAccountV2>;

const AUTOPILOT_ON = process.env.NEXT_PUBLIC_AUTOPILOT === '1';

/** Where the floating pill stays out of the way: Kelly's hub already shows the same pill
 *  in its tab bar, and the OAuth popup carries no chrome. Mirrors the Ask Kelly dock. */
const PILL_HIDDEN_ON = ['/v2/kelly', '/auth'];

export interface EngineSeeds {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
}

const NO_SEEDS: EngineSeeds = { markets: [], pricerSeeds: {} };

/** What a consumer reads before the host has published a view, and whenever the engine
 *  is off: the same shape with nothing in it, so nobody has to null-check. */
const IDLE_VIEW: AutopilotEngineView = {
  candidates: [],
  spot: null,
  ready: false,
  positions: [],
  perf: {
    openCount: 0,
    atRiskUsd: 0,
    markValueUsd: 0,
    unrealizedPnlUsd: 0,
    realizedPnlUsd: 0,
    netPnlUsd: 0,
    wins: 0,
    losses: 0,
    winRate: null,
  },
};

/* --------------------------- who wants an engine -------------------------- */

/**
 * Module-level and reference-counted, the same shape as the live-pyth driver: N views
 * asking for an engine collapse to ONE, and the count outlives any single mount. A view
 * hands over its server snapshot at the same time, so a cold landing straight on the
 * Autopilot tab starts warm instead of waiting a poll for its first market list.
 */
interface Demand {
  wanted: number;
  seeds: EngineSeeds;
}

const NO_DEMAND: Demand = { wanted: 0, seeds: NO_SEEDS };
let demand: Demand = NO_DEMAND;
const listeners = new Set<() => void>();

function setDemand(next: Demand): void {
  demand = next;
  for (const l of listeners) l();
}

function subscribeDemand(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Ask for a live engine while the calling view is mounted, and seed it. The Autopilot
 * panel calls this: it shows the live market read (spot, markets watched) before a run is
 * ever armed, which the gate cannot infer from the store on its own. Pass a STABLE seeds
 * object (memoise it) so this does not re-register on every render.
 */
export function useAutopilotEngineWanted(seeds: EngineSeeds): void {
  useEffect(() => {
    setDemand({ wanted: demand.wanted + 1, seeds });
    return () => setDemand({ ...demand, wanted: Math.max(0, demand.wanted - 1) });
  }, [seeds]);
}

function useDemand(): Demand {
  return useSyncExternalStore(
    subscribeDemand,
    () => demand,
    () => NO_DEMAND,
  );
}

/* --------------------------------- context -------------------------------- */

export interface AutopilotEngineContextValue {
  engine: AutopilotEngineView;
  /** The ONE account instance the panel and the engine share (see the note at the top). */
  acct: Acct;
}

const Ctx = createContext<AutopilotEngineContextValue | null>(null);

export function useAutopilotEngineContext(): AutopilotEngineContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAutopilotEngineContext must be used inside <AutopilotEngineProvider>.');
  return ctx;
}

/* -------------------------------- provider -------------------------------- */

/** True once this page load has read the persisted store. Module-level rather than a ref
 *  so it also survives the provider unmounting on a trip out to a legacy route and back. */
let didRehydrate = false;

export function AutopilotEngineProvider({ children }: { children: ReactNode }) {
  // A build-time flag, so this branch never flips at runtime and never remounts the tree.
  return AUTOPILOT_ON ? <LiveEngineProvider>{children}</LiveEngineProvider> : <>{children}</>;
}

function LiveEngineProvider({ children }: { children: ReactNode }) {
  const acct = usePredictAccountV2();
  const status = useAutopilotStore((s) => s.status);
  const openCount = useAutopilotStore((s) => s.run.open.length);
  const { wanted, seeds } = useDemand();
  const [view, setView] = useState<AutopilotEngineView | null>(null);

  /**
   * Read the saved run and results ONCE per page load, not once per panel mount.
   *
   * Rehydrating stops any run it finds still armed, which is the safety rule and is right
   * after a refresh. It was wrong after a walk to the Trade page and back, which is what
   * used to happen when this lived in the panel: the run died and the log blamed a reload
   * that never took place.
   */
  useEffect(() => {
    if (didRehydrate) {
      useAutopilotStore.setState({ hydrated: true });
      return;
    }
    didRehydrate = true;
    // Whatever the read does, the page must fill in: a failed or empty read still ends
    // the skeleton, with the defaults in place of a saved state.
    void Promise.resolve(useAutopilotStore.persist.rehydrate()).finally(() =>
      useAutopilotStore.setState({ hydrated: true }),
    );
  }, []);

  const on = engineShouldRun({ status, openCount, wanted });
  const value = useMemo<AutopilotEngineContextValue>(() => ({ engine: view ?? IDLE_VIEW, acct }), [view, acct]);

  return (
    <Ctx.Provider value={value}>
      {/* A sibling of the page, never a parent. `children` keeps its element identity
          across these renders, so React skips re-rendering the page under us. */}
      {on && <EngineHost acct={acct} seeds={seeds} onView={setView} />}
      {children}
      <GlobalRunPill />
    </Ctx.Provider>
  );
}

/** Runs the engine and publishes its view upward. Renders nothing. */
function EngineHost({
  acct,
  seeds,
  onView,
}: {
  acct: Acct;
  seeds: EngineSeeds;
  onView: (v: AutopilotEngineView | null) => void;
}) {
  const view = useAutopilotEngine({ markets: seeds.markets, pricerSeeds: seeds.pricerSeeds, acct });
  const { candidates, spot, ready, positions, perf } = view;

  /**
   * Publish on a CONTENT signature, never on identity.
   *
   * None of these fields is referentially stable: `useV2Pricers` builds a fresh object
   * every render, so the `candidates` / `positions` / `perf` memos downstream of it
   * rebuild every render too. Depending on them directly set state on every render, which
   * re-rendered this host, which set state again: an update-depth crash that took every
   * /v2 page down with it, because this now sits in the layout.
   *
   * So the effect still runs on every render and simply declines to publish when nothing
   * actually changed. The signature deliberately reduces `candidates` to its LENGTH, which
   * is the only part of it any consumer reads: stringifying a hundred markets and their
   * pricers every render is exactly the cost this is here to avoid.
   */
  const sigRef = useRef<string | null>(null);
  useEffect(() => {
    const sig = JSON.stringify({ n: candidates.length, spot, ready, positions, perf });
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    onView({ candidates, spot, ready, positions, perf });
  }, [candidates, spot, ready, positions, perf, onView]);
  // Leaving the last view behind after the engine stops would show a live read that has
  // quietly stopped being live.
  useEffect(() => () => onView(null), [onView]);
  return null;
}

/** The floating read of a run, parked one launcher-height above the Ask Kelly fox (h-12
 *  at bottom-24, bottom-6 from lg) and right-aligned with it, so the two read as a stack. */
function GlobalRunPill() {
  const pathname = usePathname();
  if (pathname && PILL_HIDDEN_ON.some((p) => pathname.startsWith(p))) return null;
  return <RunPill className="fixed right-4 bottom-[9.75rem] z-40 shadow-lg backdrop-blur-sm lg:right-6 lg:bottom-[5.25rem]" />;
}
