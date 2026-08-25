'use client';

/**
 * useAutopilotEngine — the driver that runs Autopilot while it is armed.
 *
 * It assembles the SAME live context the co-pilot uses (priceable markets, spot,
 * the 1-minute BTC tape, insights), and on each tick:
 *   1. resolves any real position whose expiry has passed against its on-chain
 *      settlement (marks it won/lost, which drives the loss-limit),
 *   2. prunes finished positions (simulated at expiry; real after a grace window),
 *   3. checks the terminal stop conditions (autoStopReason) and disarms if any hold,
 *   4. asks Kelly for her best-value pick over the trader's allowed windows,
 *   5. runs that pick through the pure gate, and
 *   6. either SIMULATES the fire (watch mode) or PLACES it for real through the
 *      session key (no wallet popup) and mints a Walrus receipt for it.
 *
 * All the safety logic is in lib/autopilot/policy.ts; this hook wires live data +
 * the on-chain account to it and paces the loop. Real trading only happens when the
 * trader turned watch mode OFF (store.dryRun === false) and the session key can
 * actually trade — otherwise every fire is a no-cost simulation.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { getV2MarketState } from '@/lib/api/v2/client';
import { toFloat, fromQuote } from '@/config/scale';
import { planBinaryBudgetMint } from '@/lib/sui/v2/budget-mint';
import { positionMarkPrice, valueV2Position, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { recordCall, binaryIntent } from '@/lib/copilot/receipts-client';
import { useV2Markets } from './use-v2-markets';
import { useV2Pricers } from './use-v2-pricers';
import { useV2Spot } from './use-v2-spot';
import { useNow } from './use-now';
import { useBtcInsights, type BtcInsights } from './use-btc-insights';
import { usePredictAccountV2 } from './use-predict-account-v2';
import { respondToIntent, type BetCandidate } from '@/lib/copilot/respond';
import {
  autoStopReason,
  classifyTenor,
  gateReasonLabel,
  gateTrade,
  settleOutcome,
  type AutopilotHealth,
  type AutopilotRuntime,
  type GateCode,
  type GateResult,
  type ProposedTrade,
  type TradeSide,
} from '@/lib/autopilot/policy';
import { useAutopilotStore, type OpenPosition } from '@/lib/store/autopilot-store';

/** How often the armed loop evaluates. The pricer refreshes about every 5s, so a
 *  6s tick reads a fresh surface without hammering it. */
const TICK_MS = 6_000;
/** Treat the feed as stalled only after this long with nothing priceable, so a
 *  single blip doesn't disarm a run. */
const FEED_STALE_MS = 30_000;
/** After arming for real, give the session/gas reads this long to settle before the
 *  key/gas health can disarm the run — the on-chain authorize has landed, but the
 *  local expiry/gas queries refetch on their own 30s interval, so without a warmup
 *  wider than that a fresh arm could disarm itself on a stale "not funded yet" read
 *  (worst case: a Slush session that self-funded gas inside the authorize tx). The
 *  feed-stall check still applies during warmup — only the key/gas checks wait. */
const HEALTH_WARMUP_MS = 35_000;
/** Keep a real position around this long after expiry to read its settlement; past
 *  it, retire the position unscored (a settlement we never saw can't count). */
const SETTLE_GRACE_MS = 15 * 60_000;

/** Receipts are minted only when the same flag the co-pilot uses is on (and the
 *  server writer key is set). Fire-and-forget, so a missing key just skips it. */
const RECEIPTS_ON = process.env.NEXT_PUBLIC_KELLY_RECEIPTS === '1';

/** Rule rejections worth surfacing in the log (the trader tuned these). Pacing
 *  holds (cooldown / concurrency / one-per-market) are expected and stay quiet. */
const RULE_HOLDS: ReadonlySet<GateCode> = new Set<GateCode>([
  'below_min_prob',
  'below_min_edge',
  'tenor_not_allowed',
  'side_not_allowed',
  'leverage_too_high',
]);

/** The slice of the account the engine reads/uses inside the tick (kept in a ref so
 *  the interval callback sees live values without resetting the timer). The panel
 *  passes in its single account instance, so arming (startSession, owner-signed) and
 *  firing (mintBudget, session-signed) share ONE in-flight lock and never overlap. */
export type AutopilotAcct = Pick<
  ReturnType<typeof usePredictAccountV2>,
  'mintBudget' | 'sessionCanTrade' | 'sessionLive'
>;

interface Args {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  acct: AutopilotAcct;
}

/** One currently-open Autopilot position, marked live off the pricer. */
export interface AutopilotOpenView {
  marketId: string;
  side: TradeSide;
  strike?: number;
  lower?: number;
  higher?: number;
  /** Stake put in (DUSDC). */
  stake: number;
  /** All-in entry cost (DUSDC). */
  cost: number;
  /** Win chance at entry (0..1). */
  entryProb: number;
  /** Win chance right now (0..1). */
  currentProb: number;
  /** Current mark value (DUSDC). */
  markValue: number;
  /** Live unrealized PnL (DUSDC, signed). */
  pnlUsd: number;
  /** Probability move since entry, in percentage points (signed). */
  deltaPp: number;
  expiry: number;
  dryRun: boolean;
}

/** The run's live performance tape (open + settled). */
export interface AutopilotPerf {
  openCount: number;
  /** Sum of open positions' entry cost (DUSDC at risk right now). */
  atRiskUsd: number;
  /** Sum of open positions' current mark value (DUSDC). */
  markValueUsd: number;
  /** Sum of open positions' live PnL (DUSDC, signed). */
  unrealizedPnlUsd: number;
  /** Realized PnL from settled positions this run (DUSDC, signed). */
  realizedPnlUsd: number;
  /** realized + unrealized (DUSDC, signed). */
  netPnlUsd: number;
  wins: number;
  losses: number;
  /** Win rate over settled trades only (0..1), or null before any settle. */
  winRate: number | null;
}

/**
 * What Autopilot would do RIGHT NOW, if it were armed.
 *
 * Produced by the same three steps the armed tick uses (filter to the trader's
 * windows, ask the recommender for its best-value pick, run `gateTrade`), so the
 * pre-arm preview cannot drift from the real behaviour. That mattered enough to reuse
 * the pipeline rather than re-derive it: a preview that disagrees with the engine is
 * worse than no preview.
 *
 * Note the engine picks ONE bet per tick and gates it, so this is a single would-be
 * trade, not a count of "how many markets qualify". No such count exists in the engine,
 * and inventing one here would be describing behaviour the app does not have.
 */
export interface AutopilotPreview {
  /** Kelly's current best pick, or null when she has nothing to offer at all. */
  bet: { marketId: string; strikePrice: number | null; isUp: boolean; prob: number; expiry: number; leverage: number } | null;
  /** Whether that pick clears the trader's rules. `code` says why not. */
  gate: GateResult;
}

export interface AutopilotEngineView {
  /** Markets we can currently price (Kelly's universe this tick). */
  candidates: BetCandidate[];
  spot: number | null;
  /** True once the live context has enough to reason (markets + tape). */
  ready: boolean;
  /** Currently-open positions, marked live (empty in either mode until one opens). */
  positions: AutopilotOpenView[];
  /** The run's live performance summary. */
  perf: AutopilotPerf;
  /** What would happen if you armed right now. Null until there is enough to say. */
  preview: AutopilotPreview | null;
}

/**
 * Read a real, expired position's on-chain settlement and record its outcome. Skips
 * (leaving the marketId out of `handled` so a later tick retries) when the market
 * hasn't settled yet or the read fails; scores + records once settlement is known.
 */
async function resolveSettlement(pos: OpenPosition, handled: Set<string>): Promise<void> {
  try {
    const state = await getV2MarketState(pos.marketId);
    const raw = state.settlement?.settlement_price;
    if (raw == null) {
      handled.delete(pos.marketId); // not settled yet — retry on a later tick
      return;
    }
    const price = toFloat(BigInt(raw));
    const won = settleOutcome(pos, price);
    useAutopilotStore.getState().recordSettlement(pos.marketId, won, Date.now());
  } catch {
    handled.delete(pos.marketId); // transient read failure — retry
  }
}

export function useAutopilotEngine({ markets: initialMarkets, pricerSeeds, acct }: Args): AutopilotEngineView {
  const markets = useV2Markets(initialMarkets);
  const marketIds = useMemo(() => markets.map((m) => m.expiry_market_id), [markets]);
  const pricers = useV2Pricers(marketIds, pricerSeeds, 5_000);
  const spot = useV2Spot();
  // Same shared queries the co-pilot uses (deduped by key). Enabled whenever this
  // hook is mounted, which is only on the Autopilot page.
  const { data: insights } = useBtcInsights({ enabled: true });
  const { data: candles } = useQuery<{ closes: number[] }>({
    queryKey: ['insights', 'btc', 'candles'],
    queryFn: async () => {
      const r = await fetch('/api/insights/btc/candles');
      if (!r.ok) throw new Error(`candles ${r.status}`);
      return (await r.json()) as { closes: number[] };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const candidates = useMemo<BetCandidate[]>(
    () => markets.flatMap((m) => (pricers[m.expiry_market_id] ? [{ market: m, pricer: pricers[m.expiry_market_id] }] : [])),
    [markets, pricers],
  );

  const status = useAutopilotStore((s) => s.status);
  // Subscribed (not read through getState like the tick does) because the preview has
  // to recompute the moment the trader changes a rule.
  const previewRules = useAutopilotStore((s) => s.rules);
  const previewLimits = useAutopilotStore((s) => s.limits);
  // A coarse clock for the preview. The memo has to stay pure (react-hooks/purity), so
  // `now` comes in as a dep rather than being read inside it. 5s is plenty: this is a
  // "what would happen if you armed" read, not a live quote.
  const previewNow = useNow(5_000);
  // Live-PnL inputs: the open positions + the run's realized tape (subscribed so the
  // marked view re-renders as the store changes, separate from the 6s tick).
  const open = useAutopilotStore((s) => s.run.open);
  const realizedPnlUsd = useAutopilotStore((s) => s.run.realizedPnlUsd);
  const wins = useAutopilotStore((s) => s.run.wins);
  const losses = useAutopilotStore((s) => s.run.losses);

  // Keep the freshest inputs in refs so the interval callback reads live values
  // without resetting the timer. Written in effects (never during render).
  const depsRef = useRef<{
    candidates: BetCandidate[];
    spot: number | null;
    closes: number[] | null;
    insights: BtcInsights | null;
  }>({ candidates: [], spot: null, closes: null, insights: null });
  useEffect(() => {
    depsRef.current = { candidates, spot, closes: candles?.closes ?? null, insights: insights ?? null };
  }, [candidates, spot, candles, insights]);

  // The on-chain account (session state + the placement call). usePredictAccountV2
  // returns a fresh object each render; mirror it into a ref every commit so the
  // tick can place a trade + read health without being a dependency of the loop.
  const acctRef = useRef<AutopilotAcct>(acct);
  useEffect(() => {
    acctRef.current = acct;
  });

  // Feed-freshness debounce, the last hold we logged (so it doesn't repeat), a lock
  // so only one real fire is in flight at a time, and the set of markets we've already
  // resolved/attempted settlement for (avoids re-reading the same settled market).
  const lastLiveRef = useRef<number>(0);
  const lastHoldRef = useRef<string | null>(null);
  const fireRef = useRef(false);
  const settledRef = useRef<Set<string>>(new Set());

  const tick = useCallback(() => {
    const st = useAutopilotStore.getState();
    if (st.status === 'idle') return;

    const now = Date.now();
    const { candidates, spot, closes, insights } = depsRef.current;
    const { rules, limits, dryRun } = st;
    const acct = acctRef.current;

    // 1) Resolve any expired position (sim OR real) against its on-chain settlement,
    //    so both modes build a real win/loss tape and drive the loss-limit. Watch mode
    //    scores its picks against the market's real settlement — a live backtest.
    //    Fire-and-forget; recordSettlement removes the position + realizes its PnL.
    //    Runs even while STOPPED, so a finished run's late trades still resolve into
    //    its saved result.
    for (const pos of st.run.open) {
      if (pos.expiry > now || settledRef.current.has(pos.marketId)) continue;
      settledRef.current.add(pos.marketId);
      void resolveSettlement(pos, settledRef.current);
    }
    // 2) Retire positions whose settlement never resolved within the grace window.
    st.pruneExpired(now, SETTLE_GRACE_MS);
    if (candidates.length > 0) lastLiveRef.current = now;

    // A stopped run only finishes settling its remaining positions — no health checks,
    // no picks, no new trades.
    if (st.status !== 'armed') return;

    // Health: in watch mode (or during the post-arm warmup) the trading key isn't in
    // play, so only the feed matters. Once live and warmed up, an expired or gas-starved
    // session key disarms the run.
    const warming = now - st.run.armedAt < HEALTH_WARMUP_MS;
    const feedFresh = now - lastLiveRef.current < FEED_STALE_MS;
    const health: AutopilotHealth =
      dryRun || warming
        ? { sessionLive: true, gasOk: true, feedFresh }
        : { sessionLive: acct.sessionLive, gasOk: acct.sessionLive ? acct.sessionCanTrade : true, feedFresh };

    const runtime = st.buildRuntime(now);
    const stop = autoStopReason(limits, runtime, health, now);
    if (stop) {
      st.disarm(stop, now);
      return;
    }

    // Kelly's best-value pick, but only over the windows the trader allows.
    const allowed = candidates.filter((c) => rules.tenors.includes(classifyTenor(c.market.expiry - now)));
    if (allowed.length === 0) return;

    const reply = respondToIntent(
      { kind: 'best_value' },
      { insights, candidates: allowed, now, spot, closes, selection: null },
    );
    const bet = reply.bet;
    if (!bet || !(bet.prob > 0)) return;

    const proposed: ProposedTrade = {
      kind: 'binary',
      marketId: bet.marketId,
      expiry: bet.expiry,
      prob: bet.prob,
      edge: 0, // the recommender does not surface its value edge yet (fast-follow)
      side: bet.isUp ? 'up' : 'down',
      leverage: bet.leverage ?? 1,
      sizeUsd: limits.perTradeUsd,
    };

    const gate = gateTrade(proposed, rules, limits, runtime, now);
    if (!gate.allow) {
      // Surface only the trader-rule holds, deduped, so pacing waits stay silent.
      if (RULE_HOLDS.has(gate.code)) {
        const key = `${proposed.marketId}:${gate.code}`;
        if (lastHoldRef.current !== key) {
          lastHoldRef.current = key;
          st.noteHold(gateReasonLabel(gate.code), proposed.marketId, now);
        }
      }
      return;
    }
    lastHoldRef.current = null;

    // Build the mint plan for the pick. BOTH modes use it: watch mode records a
    // simulated position with the SAME sized numbers (so its live PnL is real), and
    // live mode also signs it. Skip a dead-odds strike or a sub-minimum stake.
    const cand = allowed.find((c) => c.market.expiry_market_id === bet.marketId);
    if (!cand) return;
    const plan = planBinaryBudgetMint({
      market: cand.market,
      forward: cand.pricer.forward,
      svi: cand.pricer.svi,
      strikePrice: bet.strikePrice ?? null,
      isUp: bet.isUp,
      stake: limits.perTradeUsd,
      leverage: bet.leverage ?? 1,
    });
    if (!plan.probOk || !plan.stakeOk) return;

    // Carry the marking detail so the position marks with the terminal's own math.
    const scored: ProposedTrade = {
      ...proposed,
      leverage: plan.lev, // the clamped leverage the mint actually uses
      strike: plan.strike,
      entryProb: plan.entryProb,
      qty: fromQuote(plan.quantity),
      cost: fromQuote(plan.estCostBase),
    };

    // Watch mode: simulate the fire with the same numbers, no signing.
    if (dryRun) {
      st.recordPlacement(scored, { dryRun: true }, now);
      return;
    }

    // --- real fire (session key, no popup) --------------------------------------
    // One at a time: a fire is async and records only on success, so the guard stops
    // a second candidate firing in the ~1-2s before this one lands (cooldown backs it up).
    if (fireRef.current || !acct.sessionCanTrade) return;
    fireRef.current = true;
    void (async () => {
      try {
        // No `deposit`: mintBudget routes through the session key (it can only spend
        // the trading-account balance, never top it up or withdraw).
        const digest = await acct.mintBudget({ ...plan.mint }, { silentSuccess: true });
        if (digest) {
          useAutopilotStore.getState().recordPlacement(scored, { dryRun: false, digest }, Date.now());
          if (RECEIPTS_ON) {
            void recordCall(
              binaryIntent({ marketId: bet.marketId, expiry: bet.expiry, isUp: bet.isUp, strikePrice: plan.strike }),
            );
          }
        }
      } finally {
        fireRef.current = false;
      }
    })();
  }, []);

  // Keep the loop alive while armed, and also while a STOPPED run still has open
  // positions to settle (so its saved result completes on its own). It shuts off
  // once a stopped run's last position resolves.
  const settling = status === 'stopped' && open.length > 0;
  useEffect(() => {
    if (status !== 'armed' && !settling) return;
    if (status === 'armed') {
      lastLiveRef.current = Date.now(); // start the feed-freshness clock on arm
      fireRef.current = false;
      settledRef.current.clear(); // a fresh run scores its own positions from scratch
    }
    tick(); // evaluate immediately
    const h = setInterval(tick, TICK_MS);
    return () => clearInterval(h);
  }, [status, settling, tick]);

  // Live PnL per still-open position, marked off the current pricer with the
  // terminal's own math. A position with no live pricer (expired / pending
  // settlement) drops out — this list is exactly the "currently open" trades.
  const positions = useMemo<AutopilotOpenView[]>(() => {
    const out: AutopilotOpenView[] = [];
    for (const p of open) {
      const pricer = pricers[p.marketId];
      if (!pricer || p.qty == null || p.cost == null) continue;
      const vp: V2PortfolioPosition = {
        key: p.marketId,
        direction: p.side === 'up' ? 'Up' : p.side === 'down' ? 'Down' : 'Range',
        strike: p.strike,
        band: p.side === 'range' && p.lower != null && p.higher != null ? { lower: p.lower, higher: p.higher } : undefined,
        expiry: p.expiry,
        qty: p.qty,
        cost: p.cost,
        entryPrice: p.entryProb,
        leverage: p.leverage,
        settled: false,
      };
      const mark = positionMarkPrice(vp, pricer);
      if (mark == null) continue;
      const valued = valueV2Position(vp, mark);
      out.push({
        marketId: p.marketId,
        side: p.side,
        strike: p.strike,
        lower: p.lower,
        higher: p.higher,
        stake: p.sizeUsd,
        cost: p.cost,
        entryProb: p.entryProb ?? mark,
        currentProb: mark,
        markValue: valued.markValue ?? 0,
        pnlUsd: valued.pnl ?? 0,
        deltaPp: valued.deltaPp ?? 0,
        expiry: p.expiry,
        dryRun: p.dryRun,
      });
    }
    return out.sort((a, b) => a.expiry - b.expiry); // soonest to settle first
  }, [open, pricers]);

  const perf = useMemo<AutopilotPerf>(() => {
    const markValueUsd = positions.reduce((a, p) => a + p.markValue, 0);
    const atRiskUsd = positions.reduce((a, p) => a + p.cost, 0);
    const unrealizedPnlUsd = positions.reduce((a, p) => a + p.pnlUsd, 0);
    const resolved = wins + losses;
    return {
      openCount: positions.length,
      atRiskUsd,
      markValueUsd,
      unrealizedPnlUsd,
      realizedPnlUsd,
      netPnlUsd: realizedPnlUsd + unrealizedPnlUsd,
      wins,
      losses,
      winRate: resolved > 0 ? wins / resolved : null,
    };
  }, [positions, realizedPnlUsd, wins, losses]);

  /** Mirrors the armed tick's pick-and-gate, with an untouched runtime (nothing has
   *  fired yet), so the pacing gates cannot report a cooldown that does not exist. */
  const preview = useMemo<AutopilotPreview | null>(() => {
    if (candidates.length === 0) return null;
    const now = previewNow;
    const allowed = candidates.filter((c) => previewRules.tenors.includes(classifyTenor(c.market.expiry - now)));
    if (allowed.length === 0) return { bet: null, gate: { allow: false, code: 'tenor_not_allowed' } };

    const reply = respondToIntent(
      { kind: 'best_value' },
      { insights: insights ?? null, candidates: allowed, now, spot, closes: candles?.closes ?? null, selection: null },
    );
    const bet = reply.bet;
    if (!bet || !(bet.prob > 0)) return null;

    const proposed: ProposedTrade = {
      kind: 'binary',
      marketId: bet.marketId,
      expiry: bet.expiry,
      prob: bet.prob,
      edge: 0,
      side: bet.isUp ? 'up' : 'down',
      leverage: bet.leverage ?? 1,
      sizeUsd: previewLimits.perTradeUsd,
    };
    const idleRuntime: AutopilotRuntime = {
      armedAt: now,
      spentUsd: 0,
      tradeCount: 0,
      openCount: 0,
      consecutiveLosses: 0,
      lastTradeAt: null,
      firedMarkets: {},
    };
    return {
      bet: {
        marketId: bet.marketId,
        strikePrice: bet.strikePrice ?? null,
        isUp: bet.isUp,
        prob: bet.prob,
        expiry: bet.expiry,
        leverage: bet.leverage ?? 1,
      },
      gate: gateTrade(proposed, previewRules, previewLimits, idleRuntime, now),
    };
  }, [candidates, previewRules, previewLimits, insights, spot, candles, previewNow]);

  return {
    candidates,
    spot,
    ready: candidates.length > 0 && (candles?.closes?.length ?? 0) > 0,
    positions,
    perf,
    preview,
  };
}
