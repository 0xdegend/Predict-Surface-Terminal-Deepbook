/**
 * lib/store/autopilot-store.ts — the Autopilot run, kept client-only (Zustand).
 *
 * The SETTINGS (rules + limits + dry-run), the RESULTS archive (finished runs), AND
 * the live RUN (status, counters, open positions, log) all persist to localStorage,
 * so a page reload still SHOWS an in-progress run and its open trades keep settling.
 * SAFETY RULE, preserved: a reload never RESUMES placing trades. `_resumeAfterReload`
 * lands any persisted armed run as `stopped` (its open positions still settle + show,
 * but no new trades fire) and flags it `interruptedByReload` — so nothing, least of
 * all real money, ever trades on its own after a refresh. When a run stops it is
 * snapshotted into the archive, and completes in place as its late trades settle.
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
  type TradeSide,
} from '@/lib/autopilot/policy';
import { presetPatch, DEFAULT_PRESET } from '@/lib/autopilot/presets';
import { emptyIntent, type SetupIntent } from '@/lib/autopilot/setup-parser';

/** One line of Kelly's Auto-mode setup conversation. */
export interface SetupTurn {
  id: number;
  who: 'kelly' | 'trader';
  text: string;
}

/**
 * The Auto-mode conversation, kept in the store rather than in the card's own state.
 *
 * It used to be local `useState`, so walking to Portfolio and back threw away a setup
 * the trader had just spent four replies building. It lives here because the store is
 * already the persisted one, and because being the single source of truth avoids the
 * race a local mirror would have: the store uses `skipHydration` (the panel rehydrates
 * after mount), so a component seeding itself from `useState` would always read the
 * pre-hydration value and a mirror effect would write its empty state back over the
 * saved one. Reading straight from the store means rehydration is just a re-render.
 *
 * This is deliberately ONE conversation, not a history. Past chats are their own
 * feature; this only promises that leaving the screen does not wipe what is on it.
 */
export interface SetupChat {
  turns: SetupTurn[];
  /** What Kelly has understood so far, so the slots and gaps survive the trip too. */
  intent: SetupIntent;
  /** Monotonic, so React keys stay stable across a rehydrate. */
  nextId: number;
}

function freshSetupChat(): SetupChat {
  return { turns: [], intent: emptyIntent(), nextId: 1 };
}

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
 *  can be reasoned about. A dry-run (simulated) position is pruned once its expiry
 *  passes — its outcome is unknown. A real position is kept past expiry so the
 *  engine can read its on-chain settlement and score it (win/loss drives the
 *  loss-limit), then dropped by recordSettlement or a grace-prune. */
export interface OpenPosition {
  marketId: string;
  expiry: number;
  sizeUsd: number;
  /** Direction/kind, so a settled position can be scored (see settleOutcome). */
  side: TradeSide;
  /** True when simulated (watch mode). Sim and real are both scored against the
   *  chain's settlement — the only difference is a real one actually placed a trade. */
  dryRun: boolean;
  /** binary scoring strike (USD, snapped); range uses lower/higher instead. */
  strike?: number;
  lower?: number;
  higher?: number;
  /** Marking detail so live PnL uses the terminal's own math (lib/portfolio/v2). */
  entryProb?: number;
  /** Sized notional (DUSDC) — a win pays this minus the leverage floor. */
  qty?: number;
  /** All-in entry cost (DUSDC): stake plus mint fee. */
  cost?: number;
  /** Leverage multiple (1 = none) — drives the leveraged mark/settlement floor. */
  leverage?: number;
  /** When it was placed (ms epoch) — carried into the results tape for ordering. */
  openedAt?: number;
  /** On-chain tx digest of the real placement (Phase 1), so the verifiable session
   *  report can carry a checkable proof per trade. Null for a watch-mode sim. */
  digest?: string | null;
}

/** One finished trade in a run's results tape (settled won/lost, or pending when it
 *  never resolved before the run's positions were let go). */
export interface RunTradeResult {
  marketId: string;
  side: TradeSide;
  strike?: number;
  lower?: number;
  higher?: number;
  /** Stake put in (DUSDC). */
  stake: number;
  /** Win chance at entry (0..1). */
  entryProb: number;
  outcome: 'won' | 'lost' | 'pending';
  /** Realized PnL (DUSDC, signed); 0 for a pending trade. */
  pnlUsd: number;
  /** When it was placed (ms epoch). */
  at: number;
  /** On-chain tx digest of the real placement, so a saved run's trades stay verifiable
   *  in the session report even after the rolling log scrolls off. Null for a sim. */
  digest?: string | null;
}

/** A finished run, saved to the Results archive (persisted). Completes in place as
 *  late trades settle while the tab is open. */
export interface RunResult {
  id: string;
  armedAt: number;
  endedAt: number;
  /** True when this was a watch-mode (simulated) run — a live backtest. */
  dryRun: boolean;
  /** Why the run ended. */
  stopReason: StopReason | 'manual';
  budgetUsd: number;
  perTradeUsd: number;
  tradeCount: number;
  wins: number;
  losses: number;
  /** Trades still awaiting settlement at snapshot time. */
  pendingCount: number;
  realizedPnlUsd: number;
  trades: RunTradeResult[];
  /** Walrus blob id of the signed, verifiable session report, once the trader mints one
   *  for this run (on demand). Absent until then. */
  reportBlobId?: string;
}

interface Run {
  id: string;
  armedAt: number;
  spentUsd: number;
  tradeCount: number;
  consecutiveLosses: number;
  lastTradeAt: number | null;
  firedMarkets: Record<string, number>;
  open: OpenPosition[];
  /** Realized PnL (DUSDC) from settled positions this run — the "performance" tape. */
  realizedPnlUsd: number;
  wins: number;
  losses: number;
  /** Each terminal trade this run (won/lost, or pending if let go unsettled) — the
   *  raw material for the run's saved result. */
  settled: RunTradeResult[];
}

// A fresh setup lands on the Balanced preset, so the DEFAULTS are DERIVED from it (one
// source of truth — the preset picker highlights "Balanced" on first load with no drift).
// Only the money + time fields, which a preset never sets, are chosen here: a small
// budget, a modest per-trade size, a short leash. The trader widens these on purpose.
const _balanced = presetPatch(DEFAULT_PRESET);

export const DEFAULT_RULES: AutopilotRules = {
  minEdge: 0,
  minProb: _balanced.rules.minProb!,
  maxLeverage: _balanced.rules.maxLeverage!,
  tenors: _balanced.rules.tenors!,
  sides: _balanced.rules.sides!,
};

export const DEFAULT_LIMITS: AutopilotLimits = {
  budgetUsd: 25,
  perTradeUsd: 5,
  armDurationMs: 60 * 60_000,
  maxTrades: _balanced.limits.maxTrades!,
  maxConcurrent: _balanced.limits.maxConcurrent!,
  cooldownMs: _balanced.limits.cooldownMs!,
  maxConsecutiveLosses: _balanced.limits.maxConsecutiveLosses!,
};

const MAX_LOG = 120;
/** How many finished runs to keep in the Results archive (newest first). */
const MAX_HISTORY = 30;
/** Cap the trades stored per saved run (a run's maxTrades is small; this is a guard). */
const MAX_RESULT_TRADES = 200;

/** A do-nothing store for SSR / tests where localStorage is absent, so persist
 *  stays silent instead of warning on every write. The browser uses the real one. */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/**
 * True once the persisted blob has been READ. Until then this store must not write.
 *
 * THE HOLE THIS CLOSES. `skipHydration: true` (see below) means the store boots at its
 * defaults, `history: []` among them, and waits for the panel to call `rehydrate()` in
 * a mount effect. But `persist` writes on EVERY `set()`, so anything that changed state
 * inside that window flushed the empty defaults straight over a trader's saved runs.
 *
 * The window is not theoretical. Every effect inside `useAutopilotEngine` (called at the
 * top of the panel) runs before the panel's own rehydrate effect, and a store-file edit
 * during development hot-replaces this module, rebuilding the store at defaults while
 * the mounted panel's `[]` effect does not run again. One `set()` after either and the
 * archive is gone, with nothing in the code that looks like it deletes anything.
 *
 * Refusing writes until the read has happened makes the ordering irrelevant: the worst
 * a premature `set()` can now do is not be saved, which the next real one fixes.
 */
let hydrated = false;

const browserStorage: StateStorage = {
  getItem: (name) => window.localStorage.getItem(name),
  setItem: (name, value) => {
    if (!hydrated) return; // never write over a blob we have not read
    window.localStorage.setItem(name, value);
  },
  removeItem: (name) => window.localStorage.removeItem(name),
};

let seq = 0;
const nextId = (now: number) => `${now}-${seq++}`;

const freshRun = (now: number): Run => ({
  id: nextId(now),
  armedAt: now,
  spentUsd: 0,
  tradeCount: 0,
  consecutiveLosses: 0,
  lastTradeAt: null,
  firedMarkets: {},
  open: [],
  realizedPnlUsd: 0,
  wins: 0,
  losses: 0,
  settled: [],
});

/** Turn an open position into a results-tape trade with a known outcome. */
function toTradeResult(pos: OpenPosition, outcome: RunTradeResult['outcome'], pnlUsd: number): RunTradeResult {
  return {
    marketId: pos.marketId,
    side: pos.side,
    strike: pos.strike,
    lower: pos.lower,
    higher: pos.higher,
    stake: pos.sizeUsd,
    entryProb: pos.entryProb ?? 0,
    outcome,
    pnlUsd,
    at: pos.openedAt ?? pos.expiry,
    digest: pos.digest ?? null,
  };
}

/**
 * Snapshot a run into a saveable result. Its trades are the terminal ones recorded
 * so far (settled won/lost + any let go as pending) PLUS the still-open positions as
 * pending, so a run saved mid-settlement shows the whole picture and fills in as the
 * open ones resolve. Ordered by placed time.
 */
function snapshotRun(
  run: Run,
  dryRun: boolean,
  limits: AutopilotLimits,
  stopReason: StopReason | 'manual',
  endedAt: number,
): RunResult {
  const openPending = run.open.map((p) => toTradeResult(p, 'pending', 0));
  const trades = [...run.settled, ...openPending].sort((a, b) => a.at - b.at).slice(0, MAX_RESULT_TRADES);
  return {
    id: run.id,
    armedAt: run.armedAt,
    endedAt,
    dryRun,
    stopReason,
    budgetUsd: limits.budgetUsd,
    perTradeUsd: limits.perTradeUsd,
    tradeCount: run.tradeCount,
    wins: run.wins,
    losses: run.losses,
    pendingCount: trades.filter((t) => t.outcome === 'pending').length,
    realizedPnlUsd: run.realizedPnlUsd,
    trades,
  };
}

/** Insert or update a result in the archive. The FIRST insert (on stop) fixes
 *  endedAt; later updates (as trades settle) replace the entry but keep that time. */
function upsertHistory(history: RunResult[], result: RunResult): RunResult[] {
  if (history[0]?.id === result.id) {
    return [{ ...result, endedAt: history[0].endedAt }, ...history.slice(1)];
  }
  return [result, ...history].slice(0, MAX_HISTORY);
}

const money = (v: number) => `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
const signedMoney = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v) % 1 === 0 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** What a settled position realizes (DUSDC), given its stored entry facts. A win
 *  pays the notional above the static leverage floor minus cost; a loss is -cost.
 *  Mirrors lib/portfolio/v2 (positionWinPayout/valueV2Position) with entry-derived
 *  floor, kept inline so the store stays free of the portfolio + SVI deps. */
function realizedPnl(pos: OpenPosition, won: boolean): number {
  const cost = pos.cost ?? 0;
  if (!won) return -cost;
  const qty = pos.qty ?? 0;
  const L = pos.leverage ?? 1;
  const floor = L > 1 && pos.entryProb != null ? pos.entryProb * qty * (1 - 1 / L) : 0;
  const payout = Math.max(0, qty - floor);
  return payout - cost;
}

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

  // --- run (persisted for display; never resumes placing trades on reload) ---
  status: AutopilotStatus;
  run: Run;
  stopReason: StopReason | null;
  log: AutopilotLogEntry[];
  /** True right after a reload landed an armed run as stopped for safety. Cleared on
   *  the next arm/reset. Drives a "picked up where you left off" banner. */
  interruptedByReload: boolean;

  // --- results archive (persisted) ---
  /** Finished runs, newest first. A run is saved when it stops and completes in
   *  place as its late trades settle (while the tab stays open). */
  history: RunResult[];

  // --- Auto-mode setup conversation (persisted) ---
  setupChat: SetupChat;

  // --- settings actions ---
  /** Append one line to the setup conversation. */
  pushSetupTurn: (who: SetupTurn['who'], text: string) => void;
  /** Replace what Kelly has understood so far. */
  setSetupIntent: (intent: SetupIntent) => void;
  /** Wipe the conversation (the card's "Start over"). */
  resetSetupChat: () => void;

  setRules: (patch: Partial<AutopilotRules>) => void;
  setLimits: (patch: Partial<AutopilotLimits>) => void;
  setDryRun: (on: boolean) => void;

  // --- run actions ---
  arm: (now: number) => void;
  disarm: (reason: StopReason | 'manual', now: number) => void;
  reset: () => void;
  /** Drop positions we no longer track. Every position (sim or real) is kept until
   *  `expiry + graceMs` so the engine has time to read its on-chain settlement and
   *  score it (win/loss → the performance tape + loss-limit); past that it's dropped
   *  unscored. Returns the count pruned. Concurrency already excludes expired
   *  positions (see buildRuntime), so this is about scoring + freeing memory, not the
   *  open cap. */
  pruneExpired: (now: number, graceMs?: number) => number;
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

  // --- results archive actions ---
  /** Remove one saved run from the archive. */
  deleteResult: (id: string) => void;
  /** Empty the whole Results archive. */
  clearHistory: () => void;
  /** Attach the minted verifiable-report blob id to a saved run. */
  attachReport: (id: string, blobId: string) => void;

  /** Reload-safety hook (called once after the persisted state rehydrates): a run
   *  never resumes placing trades. An armed run lands stopped (open positions still
   *  settle + show), is flagged interrupted, and saved to results like any finish. */
  _resumeAfterReload: () => void;

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
      interruptedByReload: false,
      history: [],
      setupChat: freshSetupChat(),

      pushSetupTurn: (who, text) =>
        set((s) => ({
          setupChat: {
            ...s.setupChat,
            turns: [...s.setupChat.turns, { id: s.setupChat.nextId, who, text }],
            nextId: s.setupChat.nextId + 1,
          },
        })),
      setSetupIntent: (intent) => set((s) => ({ setupChat: { ...s.setupChat, intent } })),
      resetSetupChat: () => set({ setupChat: freshSetupChat() }),

      setRules: (patch) => set((s) => ({ rules: { ...s.rules, ...patch } })),
      setLimits: (patch) => set((s) => ({ limits: { ...s.limits, ...patch } })),
      setDryRun: (on) => set({ dryRun: on }),

      arm: (now) =>
        set((s) => ({
          status: 'armed',
          run: freshRun(now),
          stopReason: null,
          interruptedByReload: false,
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
          // Save the run to Results the moment it ends (if it did anything). It then
          // completes in place as any late trades settle. A no-trade run isn't saved.
          history:
            s.run.tradeCount > 0 ? upsertHistory(s.history, snapshotRun(s.run, s.dryRun, s.limits, reason, now)) : s.history,
          log: appendLog(s.log, {
            id: nextId(now),
            at: now,
            kind: 'disarmed',
            text: reason === 'manual' ? 'You switched Autopilot off' : `Autopilot stopped: ${stopReasonLabel(reason)}`,
          }),
        })),

      reset: () => set({ status: 'idle', run: freshRun(0), stopReason: null, log: [], interruptedByReload: false }),

      pruneExpired: (now, graceMs = 0) => {
        const before = get().run.open;
        const dropped = before.filter((p) => p.expiry + graceMs <= now);
        if (dropped.length === 0) return 0;
        const open = before.filter((p) => p.expiry + graceMs > now);
        set((s) => {
          // A dropped position never settled in time — record it as a pending outcome
          // so the results tape still shows it happened (not silently lost).
          const settled = [...s.run.settled, ...dropped.map((p) => toTradeResult(p, 'pending', 0))];
          const run = { ...s.run, open, settled };
          return {
            run,
            history:
              s.status === 'stopped' && run.tradeCount > 0
                ? upsertHistory(s.history, snapshotRun(run, s.dryRun, s.limits, s.stopReason ?? 'manual', now))
                : s.history,
          };
        });
        return dropped.length;
      },

      recordPlacement: (trade, opts, now) =>
        set((s) => ({
          run: {
            ...s.run,
            spentUsd: s.run.spentUsd + trade.sizeUsd,
            tradeCount: s.run.tradeCount + 1,
            lastTradeAt: now,
            firedMarkets: { ...s.run.firedMarkets, [trade.marketId]: now },
            open: [
              ...s.run.open,
              {
                marketId: trade.marketId,
                expiry: trade.expiry,
                sizeUsd: trade.sizeUsd,
                side: trade.side,
                dryRun: opts.dryRun,
                strike: trade.strike,
                lower: trade.lower,
                higher: trade.higher,
                entryProb: trade.entryProb,
                qty: trade.qty,
                cost: trade.cost,
                leverage: trade.leverage,
                openedAt: now,
                digest: opts.digest ?? null,
              },
            ],
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
        set((s) => {
          const pos = s.run.open.find((p) => p.marketId === marketId);
          const pnl = pos ? realizedPnl(pos, won) : 0;
          const run: Run = {
            ...s.run,
            open: s.run.open.filter((p) => p.marketId !== marketId),
            consecutiveLosses: won ? 0 : s.run.consecutiveLosses + 1,
            realizedPnlUsd: s.run.realizedPnlUsd + pnl,
            wins: won ? s.run.wins + 1 : s.run.wins,
            losses: won ? s.run.losses : s.run.losses + 1,
            settled: pos ? [...s.run.settled, toTradeResult(pos, won ? 'won' : 'lost', pnl)] : s.run.settled,
          };
          return {
            run,
            // Keep the saved result in sync while a stopped run finishes settling.
            history:
              s.status === 'stopped' && run.tradeCount > 0
                ? upsertHistory(s.history, snapshotRun(run, s.dryRun, s.limits, s.stopReason ?? 'manual', now))
                : s.history,
            log: appendLog(s.log, {
              id: nextId(now),
              at: now,
              kind: 'settled',
              text: won ? `Won ${signedMoney(pnl)}` : `Lost ${signedMoney(pnl)}`,
              marketId,
            }),
          };
        }),

      noteHold: (text, marketId, now) =>
        set((s) => ({
          log: appendLog(s.log, { id: nextId(now), at: now, kind: 'held', text, marketId }),
        })),

      deleteResult: (id) => set((s) => ({ history: s.history.filter((r) => r.id !== id) })),
      clearHistory: () => set({ history: [] }),
      attachReport: (id, blobId) =>
        set((s) => ({ history: s.history.map((r) => (r.id === id ? { ...r, reportBlobId: blobId } : r)) })),

      _resumeAfterReload: () =>
        set((s) => {
          // A run that was armed when the page unloaded must NOT resume placing trades.
          // Land it stopped (open positions still settle + show via the engine), flag it
          // so the UI explains, and save it to results like any other finish.
          if (s.status !== 'armed') return {};
          const now = Date.now();
          return {
            status: 'stopped',
            stopReason: null,
            interruptedByReload: true,
            history:
              s.run.tradeCount > 0
                ? upsertHistory(s.history, snapshotRun(s.run, s.dryRun, s.limits, 'manual', now))
                : s.history,
          };
        }),

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
      /**
       * Carry an older blob forward instead of dropping it.
       *
       * Zustand DISCARDS the entire persisted state when the stored version differs and
       * no migrate is given: it logs "couldn't be migrated since no migrate function was
       * provided" and hands back nothing, so a routine schema bump would silently delete
       * a trader's whole Results archive. That is the same shape of loss the `hydrated`
       * guard above exists to prevent, from the other direction.
       *
       * Every field this store persists has only ever been ADDED, never reshaped, so
       * handing the old state back and letting the default shallow merge fill in anything
       * new is both safe and the only outcome anyone would want. The day a field changes
       * shape, this is the function that converts it: take the second `version` argument
       * and fix up that one key. Never make it return an empty object.
       */
      migrate: (persisted) => persisted as AutopilotState,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && window.localStorage ? browserStorage : noopStorage,
      ),
      // Persist the settings, the Results archive, AND the live run (so a reload shows
      // it + its open trades). _resumeAfterReload enforces that it never resumes trading.
      partialize: (s) => ({
        rules: s.rules,
        limits: s.limits,
        dryRun: s.dryRun,
        history: s.history,
        status: s.status,
        run: s.run,
        stopReason: s.stopReason,
        log: s.log,
        setupChat: s.setupChat,
      }),
      // After the persisted state loads, downgrade any armed run to stopped so nothing
      // trades on its own after a refresh.
      onRehydrateStorage: () => (state) => {
        // Unconditionally, and BEFORE the set() below: the read has happened either way,
        // and leaving this false after a failed read would silently stop persisting for
        // the rest of the session.
        hydrated = true;
        state?._resumeAfterReload();
      },
      // The panel SSRs, so rehydrating automatically would mismatch (server renders the
      // default idle state; the client would load a stopped run). Skip auto-hydration
      // and let the panel rehydrate after mount, so first paint matches the server.
      skipHydration: true,
    },
  ),
);
