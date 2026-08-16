/**
 * lib/store/autopilot-store.ts — the Autopilot run, kept client-only (Zustand).
 *
 * Two halves live here. The trader's SETTINGS (rules + limits + dry-run) persist
 * to localStorage so a returning trader keeps their setup. The live RUN (status,
 * counters, log) is deliberately NOT persisted: a page reload always lands
 * disarmed, so Autopilot can never silently resume trading after a refresh
 * without the trader arming it again on purpose.
 *
 * The pure decision logic is in lib/autopilot/policy.ts; this store only holds
 * state and composes the run log. It exposes buildRuntime(now) to hand the gate
 * a plain AutopilotRuntime snapshot.
 */
import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import {
  stopReasonLabel,
  type AutopilotRules,
  type AutopilotLimits,
  type AutopilotRuntime,
  type ProposedTrade,
  type StopReason,
} from '@/lib/autopilot/policy';

export type AutopilotStatus = 'idle' | 'armed' | 'stopped';

export type LogKind = 'armed' | 'placed' | 'held' | 'settled' | 'disarmed';

export interface AutopilotLogEntry {
  id: string;
  at: number;
  kind: LogKind;
  /** Plain-language line shown in the run log. */
  text: string;
  /** True when this was a simulated (no-signing) fire. */
  dryRun?: boolean;
  /** Tx digest of a real placement (Phase 1). */
  digest?: string | null;
  /** Walrus receipt blob id of a placement, when one was minted (Phase 1). */
  blobId?: string | null;
  marketId?: string;
}

/** A position Autopilot opened this run, tracked so concurrency and settlement
 *  can be reasoned about. In dry-run it is pruned once its expiry passes. */
interface OpenPosition {
  marketId: string;
  expiry: number;
  sizeUsd: number;
}

interface Run {
  armedAt: number;
  spentUsd: number;
  tradeCount: number;
  consecutiveLosses: number;
  lastTradeAt: number | null;
  firedMarkets: Record<string, number>;
  open: OpenPosition[];
}

/** Gentle, conservative defaults: a small budget, a modest per-trade size, a
 *  short leash. The trader widens these on purpose, they are never pre-set high. */
export const DEFAULT_RULES: AutopilotRules = {
  minProb: 0.6,
  minEdge: 0,
  tenors: ['soonest', 'hour'],
  sides: ['up', 'down'],
  maxLeverage: 2,
};

export const DEFAULT_LIMITS: AutopilotLimits = {
  budgetUsd: 25,
  perTradeUsd: 5,
  maxTrades: 5,
  maxConcurrent: 3,
  cooldownMs: 90_000,
  armDurationMs: 60 * 60_000,
  maxConsecutiveLosses: 3,
};

const MAX_LOG = 120;

/** A do-nothing store for SSR / tests where localStorage is absent, so persist
 *  stays silent instead of warning on every write. The browser uses the real one. */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

let seq = 0;
const nextId = (now: number) => `${now}-${seq++}`;

const freshRun = (now: number): Run => ({
  armedAt: now,
  spentUsd: 0,
  tradeCount: 0,
  consecutiveLosses: 0,
  lastTradeAt: null,
  firedMarkets: {},
  open: [],
});

const money = (v: number) => `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function placedLine(t: ProposedTrade, dryRun: boolean): string {
  const dir = t.side === 'range' ? 'range' : t.side.toUpperCase();
  const lev = t.leverage > 1 ? ` at ${t.leverage % 1 === 0 ? t.leverage.toFixed(0) : t.leverage.toFixed(1)}x` : '';
  const head = dryRun ? 'Would place' : 'Placed';
  return `${head} ${money(t.sizeUsd)} ${dir}${lev} · ${pct(t.prob)} to win`;
}

interface AutopilotState {
  // --- settings (persisted) ---
  rules: AutopilotRules;
  limits: AutopilotLimits;
  /** When true, Autopilot simulates fires instead of signing (Phase 0 / a safe
   *  "watch it think" mode). Defaults true so nothing can trade for real until
   *  the trader turns it off on purpose. */
  dryRun: boolean;

  // --- run (ephemeral) ---
  status: AutopilotStatus;
  run: Run;
  stopReason: StopReason | null;
  log: AutopilotLogEntry[];

  // --- settings actions ---
  setRules: (patch: Partial<AutopilotRules>) => void;
  setLimits: (patch: Partial<AutopilotLimits>) => void;
  setDryRun: (on: boolean) => void;

  // --- run actions ---
  arm: (now: number) => void;
  disarm: (reason: StopReason | 'manual', now: number) => void;
  reset: () => void;
  /** Drop positions whose expiry has passed, freeing the concurrency slot. Returns
   *  the number pruned (dry-run outcome is unknown, so streaks are untouched). */
  pruneExpired: (now: number) => number;
  /** Record a placement: bump the counters and add a log line. */
  recordPlacement: (
    trade: ProposedTrade,
    opts: { dryRun: boolean; digest?: string | null; blobId?: string | null },
    now: number,
  ) => void;
  /** Record a settled position (Phase 1): free its slot and update the streak. */
  recordSettlement: (marketId: string, won: boolean, now: number) => void;
  /** Append an informational hold/skip line (engine dedupes; store just stores). */
  noteHold: (text: string, marketId: string, now: number) => void;

  /** Build the plain runtime snapshot the pure gate consumes. */
  buildRuntime: (now: number) => AutopilotRuntime;
}

function appendLog(log: AutopilotLogEntry[], entry: AutopilotLogEntry): AutopilotLogEntry[] {
  const next = [entry, ...log];
  return next.length > MAX_LOG ? next.slice(0, MAX_LOG) : next;
}

export const useAutopilotStore = create<AutopilotState>()(
  persist(
    (set, get) => ({
      rules: DEFAULT_RULES,
      limits: DEFAULT_LIMITS,
      dryRun: true,

      status: 'idle',
      run: freshRun(0),
      stopReason: null,
      log: [],

      setRules: (patch) => set((s) => ({ rules: { ...s.rules, ...patch } })),
      setLimits: (patch) => set((s) => ({ limits: { ...s.limits, ...patch } })),
      setDryRun: (on) => set({ dryRun: on }),

      arm: (now) =>
        set((s) => ({
          status: 'armed',
          run: freshRun(now),
          stopReason: null,
          log: appendLog(s.log, {
            id: nextId(now),
            at: now,
            kind: 'armed',
            text: s.dryRun ? 'Autopilot armed in watch mode (no real trades)' : 'Autopilot armed',
          }),
        })),

      disarm: (reason, now) =>
        set((s) => ({
          status: 'stopped',
          stopReason: reason === 'manual' ? null : reason,
          log: appendLog(s.log, {
            id: nextId(now),
            at: now,
            kind: 'disarmed',
            text: reason === 'manual' ? 'You switched Autopilot off' : `Autopilot stopped: ${stopReasonLabel(reason)}`,
          }),
        })),

      reset: () => set({ status: 'idle', run: freshRun(0), stopReason: null, log: [] }),

      pruneExpired: (now) => {
        const before = get().run.open;
        const open = before.filter((p) => p.expiry > now);
        if (open.length !== before.length) set((s) => ({ run: { ...s.run, open } }));
        return before.length - open.length;
      },

      recordPlacement: (trade, opts, now) =>
        set((s) => ({
          run: {
            ...s.run,
            spentUsd: s.run.spentUsd + trade.sizeUsd,
            tradeCount: s.run.tradeCount + 1,
            lastTradeAt: now,
            firedMarkets: { ...s.run.firedMarkets, [trade.marketId]: now },
            open: [...s.run.open, { marketId: trade.marketId, expiry: trade.expiry, sizeUsd: trade.sizeUsd }],
          },
          log: appendLog(s.log, {
            id: nextId(now),
            at: now,
            kind: 'placed',
            text: placedLine(trade, opts.dryRun),
            dryRun: opts.dryRun,
            digest: opts.digest ?? null,
            blobId: opts.blobId ?? null,
            marketId: trade.marketId,
          }),
        })),

      recordSettlement: (marketId, won, now) =>
        set((s) => ({
          run: {
            ...s.run,
            open: s.run.open.filter((p) => p.marketId !== marketId),
            consecutiveLosses: won ? 0 : s.run.consecutiveLosses + 1,
          },
          log: appendLog(s.log, {
            id: nextId(now),
            at: now,
            kind: 'settled',
            text: won ? 'A trade settled a winner' : 'A trade settled a loss',
            marketId,
          }),
        })),

      noteHold: (text, marketId, now) =>
        set((s) => ({
          log: appendLog(s.log, { id: nextId(now), at: now, kind: 'held', text, marketId }),
        })),

      buildRuntime: (now) => {
        const { run } = get();
        return {
          armedAt: run.armedAt,
          spentUsd: run.spentUsd,
          tradeCount: run.tradeCount,
          openCount: run.open.filter((p) => p.expiry > now).length,
          consecutiveLosses: run.consecutiveLosses,
          lastTradeAt: run.lastTradeAt,
          firedMarkets: run.firedMarkets,
        };
      },
    }),
    {
      name: 'skew-autopilot',
      version: 1,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && window.localStorage ? window.localStorage : noopStorage,
      ),
      // Persist ONLY the settings. The run always starts fresh (disarmed) on load.
      partialize: (s) => ({ rules: s.rules, limits: s.limits, dryRun: s.dryRun }),
    },
  ),
);
