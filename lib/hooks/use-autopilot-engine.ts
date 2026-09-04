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
 *      then the holdable ones (autoPauseReason): low gas pauses the run rather than
 *      ending it, and the run resumes on its own once the key is topped up,
 *   4. asks Kelly for her picks over the trader's allowed windows: on each market a
 *      directional (UP/DOWN) pick and, when the rules allow it, a range (BTC stays
 *      between two prices), in the order she prefers them (lib/copilot/range-pick),
 *   5. runs the picks through the pure gate and the chain's own quote, and
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
import { planBinaryBudgetMint, planRangeBudgetMint } from '@/lib/sui/v2/budget-mint';
import { positionMarkPrice, valueV2Position, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { recordCall, binaryIntent, rangeIntent } from '@/lib/copilot/receipts-client';
import { useV2Markets } from './use-v2-markets';
import { useV2Pricers } from './use-v2-pricers';
import { useV2Spot } from './use-v2-spot';
import { useBtcInsights, type BtcInsights } from './use-btc-insights';
import { usePredictAccountV2 } from './use-predict-account-v2';
import { respondToIntent, type BetCandidate, type BetSuggestion } from '@/lib/copilot/respond';
import { pickRange, shapeOrder, type RangePick } from '@/lib/copilot/range-pick';
import { recommendation } from '@/lib/insights/market-read';
import {
  autoPauseReason,
  autoStopReason,
  classifyTenor,
  gateReasonLabel,
  gateTrade,
  settleOutcome,
  stakeFor,
  type AutopilotHealth,
  type GateCode,
  type ProposedTrade,
  type TradeSide,
  fitsSession,
  hasTimeToTrade,
  rankPicks,
} from '@/lib/autopilot/policy';
import { useAutopilotStore, type OpenPosition } from '@/lib/store/autopilot-store';

/** How many chain quotes one tick may spend before giving up on this tick. Each is a
 *  ~2s simulate, and the loop runs every 6s. */
const MAX_QUOTES_PER_TICK = 2;
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
  'mintBudget' | 'quoteMintBudget' | 'sessionCanTrade' | 'sessionLive'
>;

/** One of Kelly's picks on one market, with the win chance the surface gives it. */
type ShapePick =
  | { kind: 'binary'; bet: BetSuggestion; prob: number }
  | { kind: 'range'; range: RangePick; prob: number };

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
      handled.delete(positionKey(pos)); // not settled yet — retry on a later tick
      return;
    }
    const price = toFloat(BigInt(raw));
    const won = settleOutcome(pos, price);
    useAutopilotStore.getState().recordSettlement(pos.marketId, won, Date.now(), pos.openedAt);
  } catch {
    handled.delete(positionKey(pos)); // transient read failure — retry
  }
}

/** Settlement is tracked per POSITION, not per market: two bets can sit on one market
 *  (different strikes, placed a cooldown apart) and each must be scored on its own. */
const positionKey = (p: OpenPosition) => `${p.marketId}:${p.openedAt ?? ''}`;

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
      const key = positionKey(pos);
      if (pos.expiry > now || settledRef.current.has(key)) continue;
      settledRef.current.add(key);
      void resolveSettlement(pos, settledRef.current);
    }
    // 2) Retire positions whose settlement never resolved within the grace window.
    st.pruneExpired(now, SETTLE_GRACE_MS);
    if (candidates.length > 0) lastLiveRef.current = now;

    // A stopped run only finishes settling its remaining positions — no health checks,
    // no picks, no new trades.
    if (st.status === 'stopped') return;

    // Health: in watch mode (or during the post-arm warmup) the trading key isn't in
    // play, so only the feed matters. Once live and warmed up, an expired session key
    // disarms the run, and a gas-starved one pauses it.
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

    // Low gas holds the run instead of ending it: the trader tops the key up from the
    // banner and the next tick that reads it as funded puts the run back on. The stop
    // checks above still run while paused, so a run that times out (or whose key
    // expires) while it waits finishes like any other.
    const pause = autoPauseReason(health);
    if (st.status === 'paused') {
      if (!pause) st.resume(now);
      return;
    }
    if (pause) {
      st.pause(pause, now);
      return;
    }

    // Kelly's best-value pick, but only over the windows the trader allows. A null tenor is
    // a market settling past every named window, so it is dropped here too: the gate would
    // deny it anyway, but leaving it in the candidate set lets Kelly reason about a bet she
    // can never place, and the run reads as "no trades" rather than "nothing eligible".
    //
    // The same goes for a market about to settle. Her pick takes the SOONEST market, and on
    // a venue that lists a fresh 1-minute market every minute that was one with seconds
    // left (see MIN_TIME_TO_EXPIRY_MS for the day it cost real money). Filtered here so
    // she reasons over the next market with time on it, with the gate as the backstop.
    //
    // And a market this run has already bet on. One bet per market: with 1-minute markets
    // a fresh "soonest" appeared every minute, so this never came up; with the 5-minute
    // ladder the same market is the soonest for ten minutes and Kelly stacked a second
    // bet on it two minutes after the first, which then blocked the third under the
    // open-positions limit. Dropped here so she picks the NEXT market instead.
    //
    // And a market that settles after the session does: an open position past "time is
    // up" is not what the trader signed up for. Said once when it rules out everything.
    const sessionEnd = { armedAt: runtime.armedAt, durationMs: limits.armDurationMs };
    const allowed = candidates.filter((c) => {
      if (!hasTimeToTrade(c.market.expiry, now)) return false;
      if (!fitsSession(c.market.expiry, sessionEnd.armedAt, sessionEnd.durationMs)) return false;
      if (runtime.firedMarkets[c.market.expiry_market_id] != null) return false;
      const tenor = classifyTenor(c.market.expiry - now);
      return tenor !== null && rules.tenors.includes(tenor);
    });
    if (allowed.length === 0) {
      const anyLive = candidates.some((c) => hasTimeToTrade(c.market.expiry, now) && runtime.firedMarkets[c.market.expiry_market_id] == null);
      const noneFit = anyLive && !candidates.some((c) => fitsSession(c.market.expiry, sessionEnd.armedAt, sessionEnd.durationMs));
      if (noneFit && lastHoldRef.current !== 'no_fit') {
        lastHoldRef.current = 'no_fit';
        st.noteHold(gateReasonLabel('settles_after_session'), '', now);
      }
      return;
    }

    // Kelly's picks on every market still in play, then ranked by the trader's rules.
    // Her reads work one market at a time (the directional scan walks the strikes
    // around spot on that market; the range scan walks band widths), so she is asked
    // once per market for each shape the rules allow, and the shapes come back in the
    // order she prefers them: a mispriced one first, else the wider market's lean
    // decides (no clear direction reads as a range). The second shape is the fallback
    // for the same market if the first is held. Then the markets are ranked: a careful
    // run takes the surest bet on offer, a bolder run the soonest. Picks under the
    // trader's floor by the surface's own estimate are out here; the chain's price is
    // checked below, before anything fires.
    const wantsBinary = rules.sides.includes('up') || rules.sides.includes('down');
    const wantsRange = rules.sides.includes('range');
    const lean = recommendation(insights)?.pick ?? null;
    let offered = 0;
    const picks = allowed.flatMap((c) => {
      const bet = wantsBinary
        ? respondToIntent({ kind: 'best_value' }, { insights, candidates: [c], now, spot, closes, selection: null }).bet
        : undefined;
      const range = wantsRange ? pickRange(c, { closes, spot, now }) : null;
      const order = shapeOrder({
        binaryEdge: bet && bet.prob > 0 ? (bet.edge ?? 0) : null,
        rangeEdge: range ? range.edge : null,
        lean,
      });
      const shapes: ShapePick[] = order.map((k) =>
        k === 'range'
          ? { kind: 'range', range: range as RangePick, prob: (range as RangePick).prob }
          : { kind: 'binary', bet: bet as BetSuggestion, prob: (bet as BetSuggestion).prob },
      );
      offered += shapes.length;
      const clear = shapes.filter((sh) => sh.prob >= rules.minProb);
      return clear.length > 0 ? [{ cand: c, shapes: clear, prob: clear[0].prob, expiry: c.market.expiry }] : [];
    });
    const ranked = rankPicks(picks, rules.minProb);
    if (ranked.length === 0) {
      // Everything on offer is under the floor. Said once per change of the candidate
      // set rather than every six seconds.
      if (offered > 0) {
        const key = `floor:${allowed.map((c) => c.market.expiry_market_id).join(',')}`;
        if (lastHoldRef.current !== key) {
          lastHoldRef.current = key;
          st.noteHold(gateReasonLabel('below_min_prob'), allowed[0].market.expiry_market_id, now);
        }
      }
      return;
    }

    // One at a time: the rest of the tick is async (chain quotes, then the fire), so the
    // guard stops the next tick starting a second pass before this one lands.
    if (fireRef.current) return;
    fireRef.current = true;
    void (async () => {
      const store = useAutopilotStore.getState;
      const pctOf = (p: number) => `${Math.round(p * 100)}%`;
      const holdOnce = (key: string, text: string, marketId: string) => {
        if (lastHoldRef.current === key) return;
        lastHoldRef.current = key;
        store().noteHold(text, marketId, now);
      };
      let quotes = 0;

      /**
       * Try to place ONE shape on one market. 'held' is about this shape alone, so the
       * market's other shape, or the next market, may still go; 'stop' ends the tick for
       * every pick alike (a pacing hold, the quote budget, a key that cannot trade).
       */
      const attempt = async (cand: BetCandidate, shape: ShapePick): Promise<'fired' | 'held' | 'stop'> => {
        // The per-trade size, or the budget's remainder when that is smaller, so the run
        // spends what the trader put up instead of stopping a fraction short.
        const sizeUsd = stakeFor(limits, runtime);
        const proposed: ProposedTrade =
          shape.kind === 'range'
            ? {
                kind: 'range',
                marketId: shape.range.marketId,
                expiry: shape.range.expiry,
                prob: shape.range.prob,
                edge: shape.range.edge,
                side: 'range',
                leverage: 1,
                sizeUsd,
              }
            : {
                kind: 'binary',
                marketId: shape.bet.marketId,
                expiry: shape.bet.expiry,
                prob: shape.bet.prob,
                edge: shape.bet.edge ?? 0,
                side: shape.bet.isUp ? 'up' : 'down',
                leverage: shape.bet.leverage ?? 1,
                sizeUsd,
              };
        const gate = gateTrade(proposed, rules, limits, runtime, now);
        if (!gate.allow) {
          // A trader-rule hold is about THIS pick, so the next one may pass; a pacing
          // hold applies to every pick alike, so the tick is done.
          if (!RULE_HOLDS.has(gate.code)) return 'stop';
          holdOnce(`${proposed.marketId}:${proposed.side}:${gate.code}`, gateReasonLabel(gate.code), proposed.marketId);
          return 'held';
        }

        // The mint plan for the pick. Both modes use it: watch mode records a simulated
        // position with the same sized numbers, live mode also signs it. Skip a dead-odds
        // strike or band, or a sub-minimum stake.
        const base = { market: cand.market, forward: cand.pricer.forward, svi: cand.pricer.svi, stake: proposed.sizeUsd, leverage: proposed.leverage };
        const plan =
          shape.kind === 'range'
            ? planRangeBudgetMint({ ...base, lower: shape.range.lower, higher: shape.range.higher })
            : planBinaryBudgetMint({ ...base, strikePrice: shape.bet.strikePrice ?? null, isUp: shape.bet.isUp });
        if (!plan.probOk || !plan.stakeOk) return 'held';

        // The chain's own price, before anything fires. The surface's estimate got the
        // pick this far; the number the trader actually pays is what the floor is
        // held against. A market that prices the bet under the floor is passed over
        // for the next pick. Three answers are possible and only one lets the
        // estimate stand: `undefined` (no account to quote against, a watcher with no
        // wallet). `null` means the chain REFUSED the mint (8-21 enforces a per-market
        // probability policy and aborts strikes outside it), and a thrown read means
        // we could not ask; neither fires, because "unchecked" is how this morning's
        // losses happened.
        if (quotes >= MAX_QUOTES_PER_TICK) return 'stop';
        quotes++;
        let entryProb = plan.entryProb;
        let qty = fromQuote(plan.quantity);
        let cost = fromQuote(plan.estCostBase);
        const quote = await acct
          .quoteMintBudget({
            marketId: plan.mint.marketId,
            lowerTick: plan.mint.lowerTick,
            higherTick: plan.mint.higherTick,
            amount: plan.mint.amount,
            leverage: plan.mint.leverage,
          })
          .catch(() => null);
        if (quote === null) {
          holdOnce(`${proposed.marketId}:${proposed.side}:no_quote`, "Held back: the market wouldn't price that bet right now", proposed.marketId);
          return 'held';
        }
        if (quote) {
          entryProb = quote.entryProb;
          qty = fromQuote(quote.quantityBase);
          cost = fromQuote(quote.premiumBase + quote.builderFeeBase);
          if (entryProb < rules.minProb) {
            holdOnce(
              `${proposed.marketId}:${proposed.side}:chain_price`,
              `Held back: the market prices it at ${pctOf(entryProb)} to win, under your ${pctOf(rules.minProb)} floor`,
              proposed.marketId,
            );
            return 'held';
          }
        }
        lastHoldRef.current = null;

        // Carry the marking detail so the position marks with the terminal's own math,
        // and the chain's price where we have it, so the log and the live PnL start
        // from what was actually paid. The strike or band is the SNAPPED one the mint
        // uses, which is what a settled position is scored against.
        const detail: { strike: number } | { lower: number; higher: number } =
          'strike' in plan ? { strike: plan.strike } : { lower: plan.lower, higher: plan.higher };
        const scored: ProposedTrade = {
          ...proposed,
          prob: entryProb,
          leverage: plan.lev, // the clamped leverage the mint actually uses
          entryProb,
          qty,
          cost,
          ...detail,
        };

        // Watch mode: simulate the fire with the same numbers, no signing.
        if (dryRun) {
          store().recordPlacement(scored, { dryRun: true }, Date.now());
          return 'fired';
        }

        // --- real fire (session key, no popup) ----------------------------------
        if (!acct.sessionCanTrade) return 'stop';
        // No `deposit`: mintBudget routes through the session key (it can only spend
        // the trading-account balance, never top it up or withdraw).
        const digest = await acct.mintBudget({ ...plan.mint }, { silentSuccess: true });
        if (!digest) return 'stop';
        store().recordPlacement(scored, { dryRun: false, digest }, Date.now());
        if (RECEIPTS_ON) {
          void recordCall(
            'strike' in detail
              ? binaryIntent({ marketId: proposed.marketId, expiry: proposed.expiry, isUp: proposed.side === 'up', strikePrice: detail.strike })
              : rangeIntent({ marketId: proposed.marketId, expiry: proposed.expiry, lower: detail.lower, higher: detail.higher }),
          );
        }
        return 'fired';
      };

      try {
        for (const { cand, shapes } of ranked) {
          for (const shape of shapes) {
            const outcome = await attempt(cand, shape);
            if (outcome !== 'held') return;
          }
        }
      } finally {
        fireRef.current = false;
      }
    })();
  }, []);

  // Keep the loop alive while armed or paused (a paused run is still watching for its
  // gas to come back), and also while a STOPPED run still has open positions to settle
  // (so its saved result completes on its own). It shuts off once a stopped run's last
  // position resolves.
  const running = status === 'armed' || status === 'paused';
  const settling = status === 'stopped' && open.length > 0;
  // The per-run refs reset on a NEW run only, keyed on the run id: a pause and its
  // resume both change `status` and re-run this effect, and clearing the settled set
  // there would let a position mid-settlement be resolved a second time.
  const runId = useAutopilotStore((s) => s.run.id);
  const startedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (!running && !settling) return;
    if (running && startedRunRef.current !== runId) {
      startedRunRef.current = runId;
      lastLiveRef.current = Date.now(); // start the feed-freshness clock on arm
      fireRef.current = false;
      settledRef.current.clear(); // a fresh run scores its own positions from scratch
    }
    tick(); // evaluate immediately
    const h = setInterval(tick, TICK_MS);
    return () => clearInterval(h);
  }, [running, settling, runId, tick]);

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

  return {
    candidates,
    spot,
    ready: candidates.length > 0 && (candles?.closes?.length ?? 0) > 0,
    positions,
    perf,
  };
}
