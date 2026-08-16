'use client';

/**
 * useAutopilotEngine — the driver that runs Autopilot while it is armed.
 *
 * It assembles the SAME live context the co-pilot uses (priceable markets, spot,
 * the 1-minute BTC tape, insights), and on each tick:
 *   1. prunes positions whose expiry has passed (frees the concurrency slot),
 *   2. checks the terminal stop conditions (autoStopReason) and disarms if any hold,
 *   3. asks Kelly for her best-value pick over the trader's allowed windows,
 *   4. runs that pick through the pure gate, and
 *   5. Phase 0: SIMULATES the fire (records a "would place" line, no signing).
 *
 * All the safety logic is in lib/autopilot/policy.ts; this hook only wires live
 * data to it and paces the loop. Real signing is wired in Phase 1 behind the
 * dry-run flag; today the engine always simulates.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { useV2Markets } from './use-v2-markets';
import { useV2Pricers } from './use-v2-pricers';
import { useV2Spot } from './use-v2-spot';
import { useBtcInsights, type BtcInsights } from './use-btc-insights';
import { respondToIntent, type BetCandidate } from '@/lib/copilot/respond';
import {
  autoStopReason,
  classifyTenor,
  gateReasonLabel,
  gateTrade,
  type AutopilotHealth,
  type GateCode,
  type ProposedTrade,
} from '@/lib/autopilot/policy';
import { useAutopilotStore } from '@/lib/store/autopilot-store';

/** How often the armed loop evaluates. The pricer refreshes about every 5s, so a
 *  6s tick reads a fresh surface without hammering it. */
const TICK_MS = 6_000;
/** Treat the feed as stalled only after this long with nothing priceable, so a
 *  single blip doesn't disarm a run. */
const FEED_STALE_MS = 30_000;

/** Rule rejections worth surfacing in the log (the trader tuned these). Pacing
 *  holds (cooldown / concurrency / one-per-market) are expected and stay quiet. */
const RULE_HOLDS: ReadonlySet<GateCode> = new Set<GateCode>([
  'below_min_prob',
  'below_min_edge',
  'tenor_not_allowed',
  'side_not_allowed',
  'leverage_too_high',
]);

interface Args {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
}

export interface AutopilotEngineView {
  /** Markets we can currently price (Kelly's universe this tick). */
  candidates: BetCandidate[];
  spot: number | null;
  /** True once the live context has enough to reason (markets + tape). */
  ready: boolean;
}

export function useAutopilotEngine({ markets: initialMarkets, pricerSeeds }: Args): AutopilotEngineView {
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

  // Keep the freshest inputs in a ref so the interval callback reads live values
  // without resetting the timer. Written in an effect (never during render).
  const depsRef = useRef<{
    candidates: BetCandidate[];
    spot: number | null;
    closes: number[] | null;
    insights: BtcInsights | null;
  }>({ candidates: [], spot: null, closes: null, insights: null });
  useEffect(() => {
    depsRef.current = { candidates, spot, closes: candles?.closes ?? null, insights: insights ?? null };
  }, [candidates, spot, candles, insights]);

  // Feed-freshness debounce + the last hold we logged (so it doesn't repeat).
  const lastLiveRef = useRef<number>(0);
  const lastHoldRef = useRef<string | null>(null);

  const tick = useCallback(() => {
    const st = useAutopilotStore.getState();
    if (st.status !== 'armed') return;

    const now = Date.now();
    const { candidates, spot, closes, insights } = depsRef.current;
    const { rules, limits } = st;

    st.pruneExpired(now);
    if (candidates.length > 0) lastLiveRef.current = now;

    const health: AutopilotHealth = {
      // Watch mode does not need the trading key, so those stay green; the feed
      // is the one health signal that matters even while simulating.
      sessionLive: true,
      gasOk: true,
      feedFresh: now - lastLiveRef.current < FEED_STALE_MS,
    };

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
    if (gate.allow) {
      lastHoldRef.current = null;
      // Phase 0: always simulate. Phase 1 branches here on st.dryRun to fire for real.
      st.recordPlacement(proposed, { dryRun: true }, now);
      return;
    }

    // Surface only the trader-rule holds, deduped, so pacing waits stay silent.
    if (RULE_HOLDS.has(gate.code)) {
      const key = `${proposed.marketId}:${gate.code}`;
      if (lastHoldRef.current !== key) {
        lastHoldRef.current = key;
        st.noteHold(gateReasonLabel(gate.code), proposed.marketId, now);
      }
    }
  }, []);

  useEffect(() => {
    if (status !== 'armed') return;
    lastLiveRef.current = Date.now(); // start the feed-freshness clock on arm
    tick(); // evaluate immediately
    const h = setInterval(tick, TICK_MS);
    return () => clearInterval(h);
  }, [status, tick]);

  return { candidates, spot, ready: candidates.length > 0 && (candles?.closes?.length ?? 0) > 0 };
}
