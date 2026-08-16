// Autopilot policy engine — the pure safety core.
//
// Autopilot lets Kelly place trades on the trader's behalf while it is armed
// ("fully unattended"): on each tick Kelly picks her best-value bet, and only
// the picks that clear BOTH the trader's own rules AND the safety limits ever
// fire. This module holds that decision, kept pure (no wallet, no network, no
// React) so every branch is unit-tested before a single real trade is wired.
//
// Two separate questions live here, and they are NOT the same thing:
//   1. gateTrade()      — should THIS candidate fire on THIS tick? A rejection
//                         just skips the candidate; Autopilot stays armed.
//   2. autoStopReason() — should Autopilot DISARM itself now? A stop is terminal
//                         (budget spent, time up, too many losses, key/feed
//                         trouble) and ends the run.
//
// The real spending ceiling is enforced on-chain by the session budget (the
// session key cannot spend past it, top it up, or withdraw). Everything here is
// a policy layer on top of that hard floor, never a substitute for it.

/** Which listed window a market belongs to, derived from its time-to-expiry. */
export type Tenor = 'soonest' | 'hour' | 'today';

/** A tradeable direction. Binary picks are up/down; a two-sided band is 'range'. */
export type TradeSide = 'up' | 'down' | 'range';

/** Time-to-expiry buckets (ms). Kept as one place so the gate, the picker, and
 *  the UI agree on what "1h" means. Boundaries are inclusive on the upper edge:
 *  <= 20 min is soonest, <= 90 min is hour, anything longer is today. */
export const TENOR_BUCKETS = { soonestMaxMs: 20 * 60_000, hourMaxMs: 90 * 60_000 } as const;

/** Bucket a market by how long until it settles. */
export function classifyTenor(msToExpiry: number): Tenor {
  if (msToExpiry <= TENOR_BUCKETS.soonestMaxMs) return 'soonest';
  if (msToExpiry <= TENOR_BUCKETS.hourMaxMs) return 'hour';
  return 'today';
}

/** A concrete bet Kelly has picked, normalized for the gate. Sizing (sizeUsd) is
 *  stamped by the engine from the per-trade limit, not chosen by Kelly. */
export interface ProposedTrade {
  kind: 'binary' | 'range';
  marketId: string;
  /** Settlement time (ms epoch), so the gate can classify the tenor against now. */
  expiry: number;
  /** Kelly's honest win chance at the snapped strike/band (0..1). */
  prob: number;
  /** Value edge = empirical rate minus the surface's implied price. 0 when Kelly
   *  had no history to judge value (a plain safe pick), so a minEdge > 0 rule
   *  will correctly hold those back. */
  edge: number;
  side: TradeSide;
  leverage: number;
  /** The stake the engine would place, in DUSDC. */
  sizeUsd: number;
}

/** The trader's own filter on Kelly's picks (the "your rules" half of "both"). */
export interface AutopilotRules {
  /** Reject any pick below this win chance (0..1). */
  minProb: number;
  /** Reject any pick whose value edge is below this (0..1). 0 = don't require an edge. */
  minEdge: number;
  /** Only trade markets in these windows. Empty = none allowed (nothing fires). */
  tenors: Tenor[];
  /** Only trade these directions. Empty = none allowed (nothing fires). */
  sides: TradeSide[];
  /** Reject any pick above this leverage. */
  maxLeverage: number;
}

/** The always-on safety envelope. Budget is mirrored from the on-chain session
 *  budget; the rest are app-level caps on top of it. */
export interface AutopilotLimits {
  /** Total DUSDC Autopilot may deploy this run (mirrors the session budget). */
  budgetUsd: number;
  /** DUSDC per trade. */
  perTradeUsd: number;
  /** Hard cap on the number of trades this run. */
  maxTrades: number;
  /** Most open positions at once before Autopilot waits for one to settle. */
  maxConcurrent: number;
  /** Minimum gap between trades (ms), so it can't rapid-fire. */
  cooldownMs: number;
  /** Auto-disarm this long after arming (ms). */
  armDurationMs: number;
  /** Auto-disarm after this many losing trades in a row. */
  maxConsecutiveLosses: number;
}

/** The live counters for one armed run. Owned by the engine; read-only here. */
export interface AutopilotRuntime {
  /** When this run was armed (ms epoch). */
  armedAt: number;
  /** DUSDC placed so far this run. */
  spentUsd: number;
  /** Trades placed so far this run. */
  tradeCount: number;
  /** Positions still open (not yet settled) from this run. */
  openCount: number;
  /** Losing trades in a row (reset by any win). */
  consecutiveLosses: number;
  /** When the last trade fired (ms epoch), or null before the first. */
  lastTradeAt: number | null;
  /** Last fire time per market (ms epoch), to avoid stacking the same market. */
  firedMarkets: Record<string, number>;
}

/** Health of the machinery Autopilot needs to trade safely. Any false = stop. */
export interface AutopilotHealth {
  /** The session key is authorized and not expired. */
  sessionLive: boolean;
  /** The session key holds enough SUI to pay gas for another trade. */
  gasOk: boolean;
  /** The price feed / pricer is fresh (not stalled), so odds are trustworthy. */
  feedFresh: boolean;
}

/** Why a single candidate did not fire on this tick (non-terminal). */
export type GateCode =
  | 'ok'
  | 'below_min_prob'
  | 'below_min_edge'
  | 'tenor_not_allowed'
  | 'side_not_allowed'
  | 'leverage_too_high'
  | 'cooldown_active'
  | 'market_recently_fired'
  | 'max_concurrent_reached';

export interface GateResult {
  allow: boolean;
  code: GateCode;
}

/** Why Autopilot disarmed itself (terminal). */
export type StopReason =
  | 'budget_spent'
  | 'trade_cap_reached'
  | 'duration_elapsed'
  | 'loss_limit'
  | 'session_expired'
  | 'gas_low'
  | 'feed_stall';

const ALLOW: GateResult = { allow: true, code: 'ok' };
const deny = (code: GateCode): GateResult => ({ allow: false, code });

/**
 * Decide whether one of Kelly's picks may fire on this tick. Checks the trader's
 * rules first (so the log reads "held back: below your 65% floor"), then the
 * pacing limits that free up on their own (cooldown, one-per-market, concurrency).
 *
 * Budget and the trade-count cap are NOT checked here — running out of either is
 * terminal and belongs to autoStopReason(), so we never report "skipped" for a
 * run that is actually finished.
 */
export function gateTrade(
  trade: ProposedTrade,
  rules: AutopilotRules,
  limits: AutopilotLimits,
  runtime: AutopilotRuntime,
  now: number,
): GateResult {
  // --- the trader's rules (the "your rules" filter) ---
  if (trade.prob < rules.minProb) return deny('below_min_prob');
  if (rules.minEdge > 0 && trade.edge < rules.minEdge) return deny('below_min_edge');
  if (!rules.tenors.includes(classifyTenor(trade.expiry - now))) return deny('tenor_not_allowed');
  if (!rules.sides.includes(trade.side)) return deny('side_not_allowed');
  if (trade.leverage > rules.maxLeverage) return deny('leverage_too_high');

  // --- pacing (these clear on their own; the run stays armed) ---
  if (runtime.openCount >= limits.maxConcurrent) return deny('max_concurrent_reached');
  if (runtime.lastTradeAt != null && now - runtime.lastTradeAt < limits.cooldownMs) {
    return deny('cooldown_active');
  }
  const firedAt = runtime.firedMarkets[trade.marketId];
  if (firedAt != null && now - firedAt < limits.cooldownMs) return deny('market_recently_fired');

  return ALLOW;
}

/**
 * Decide whether Autopilot should disarm itself now. Returns the first terminal
 * condition that holds, or null to keep running. Ordered so the most
 * safety-critical reasons (the key or the feed) win over the routine ones
 * (budget, time), which matters only for what the log shows.
 */
export function autoStopReason(
  limits: AutopilotLimits,
  runtime: AutopilotRuntime,
  health: AutopilotHealth,
  now: number,
): StopReason | null {
  if (!health.sessionLive) return 'session_expired';
  if (!health.gasOk) return 'gas_low';
  if (!health.feedFresh) return 'feed_stall';
  if (runtime.consecutiveLosses >= limits.maxConsecutiveLosses) return 'loss_limit';
  if (runtime.tradeCount >= limits.maxTrades) return 'trade_cap_reached';
  // Nothing left to place if the remaining budget can't fund another trade.
  if (limits.budgetUsd - runtime.spentUsd < limits.perTradeUsd) return 'budget_spent';
  if (now - runtime.armedAt >= limits.armDurationMs) return 'duration_elapsed';
  return null;
}

/** Plain-language reason a candidate was held back, for the run log. */
export function gateReasonLabel(code: GateCode): string {
  switch (code) {
    case 'ok':
      return 'Placed';
    case 'below_min_prob':
      return 'Held back: below your win-chance floor';
    case 'below_min_edge':
      return 'Held back: not enough value edge';
    case 'tenor_not_allowed':
      return 'Held back: outside your allowed windows';
    case 'side_not_allowed':
      return 'Held back: that direction is off';
    case 'leverage_too_high':
      return 'Held back: over your leverage cap';
    case 'cooldown_active':
      return 'Waiting: cooling down between trades';
    case 'market_recently_fired':
      return 'Waiting: already traded this market';
    case 'max_concurrent_reached':
      return 'Waiting: at your open-positions limit';
  }
}

/** Plain-language reason Autopilot switched itself off, for the banner + log. */
export function stopReasonLabel(reason: StopReason): string {
  switch (reason) {
    case 'budget_spent':
      return 'Budget used up';
    case 'trade_cap_reached':
      return 'Reached your trade limit';
    case 'duration_elapsed':
      return 'Session time is up';
    case 'loss_limit':
      return 'Hit your losing-streak limit';
    case 'session_expired':
      return 'Trading key expired, sign in again to continue';
    case 'gas_low':
      return 'Trading key is low on gas';
    case 'feed_stall':
      return 'Paused: the price feed went quiet';
  }
}
