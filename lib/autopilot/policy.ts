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

/**
 * Time-to-expiry buckets (ms). One place so the gate, the picker and the UI agree on what
 * "1h" means. Boundaries are inclusive on the upper edge.
 *
 * `todayMaxMs` is the one that matters for safety, and it is why this function can return
 * null. These three names are the trader's whole vocabulary, and they were written when
 * every listed market settled within the hour, so "anything longer" and "today" were the
 * same thing. On 8-21 they are not: the venue lists 1-day and 1-week markets, and there is
 * a live market settling in 9.3 days. An unbounded `today` would classify that as today,
 * and Autopilot would place a nine-day unattended bet while the plan card said it settles
 * this afternoon. The trader would have consented to something they were not shown.
 */
export const TENOR_BUCKETS = {
  soonestMaxMs: 20 * 60_000,
  hourMaxMs: 90 * 60_000,
  todayMaxMs: 12 * 3_600_000,
} as const;

/**
 * The least time a market may have left for a rules-driven bet to fire on it: enough to
 * build, sign, and land the transaction and still be reading a live market, and no more.
 *
 * This is NOT a tenor rule. The founder's call (2026-09-04): Kelly may take a 1-minute
 * market, or a 5-minute one, whenever she reads a good chance on it and it settles within
 * the trader's session; the goal is good chances inside the trader's time, not a fixed
 * ladder. What she must never do is what she did that morning: two real $1,666 bets on a
 * market with 5 and 53 seconds left, at the money, that settled a few dollars the wrong
 * side. With seconds to go, client fair value is a step around spot and there is no
 * protocol brake on 8-21 (the expiry-fee window is a day wide at 1x). The honest check for
 * "a good chance" is the chain's own quote, which the engine now reads by simulating the
 * mint before it fires (lib/sui/v2/quote-mint); this floor only keeps the bet from being
 * placed so late that the read is stale by the time it lands. Forty-five seconds, so a
 * just-listed 1-minute market (two minutes out) has more than a minute of eligibility.
 */
export const MIN_TIME_TO_EXPIRY_MS = 45_000;

/** True when a market has at least MIN_TIME_TO_EXPIRY_MS left. */
export function hasTimeToTrade(expiry: number, now: number): boolean {
  return expiry - now >= MIN_TIME_TO_EXPIRY_MS;
}

/**
 * True when a market settles before the run's own clock runs out. An unattended bet
 * that outlives its session leaves the trader with an open position after "time is up",
 * which is not what they asked for: the session length is the whole of their consent.
 */
export function fitsSession(expiry: number, armedAt: number, durationMs: number): boolean {
  return expiry <= armedAt + durationMs;
}

/** A win-chance floor at or above this reads as a careful run (the same line the plan
 *  card draws), and a careful run takes the SUREST bet on offer rather than the soonest. */
export const CAREFUL_MIN_PROB = 0.68;

/**
 * Order Kelly's per-market picks for a run. Anything under the trader's floor is out.
 * A careful run then takes the highest win chance first (soonest on a tie); any other
 * run keeps the soonest first, which is the order the picks arrive in.
 */
export function rankPicks<T extends { prob: number; expiry: number }>(picks: readonly T[], minProb: number): T[] {
  const ok = picks.filter((p) => p.prob >= minProb);
  if (minProb >= CAREFUL_MIN_PROB) {
    return [...ok].sort((a, b) => b.prob - a.prob || a.expiry - b.expiry);
  }
  return [...ok].sort((a, b) => a.expiry - b.expiry);
}

/**
 * Bucket a market by how long until it settles, or null when it settles beyond anything the
 * trader's rules can name.
 *
 * Returning null rather than widening the enum is deliberate. It makes long markets
 * fail CLOSED everywhere by construction: every caller tests membership in a chosen set, and
 * null is in no set, so a market nobody has opted into is never eligible. Adding a 'week'
 * bucket instead would have made those markets eligible for anyone whose saved rules happened
 * to list it, and silently reinterpreted every rule already stored in a trader's browser.
 *
 * Long-dated markets are still fully tradeable by hand. This governs only the rules-driven
 * paths, where nobody is watching at the moment the trade fires.
 */
export function classifyTenor(msToExpiry: number): Tenor | null {
  if (msToExpiry <= TENOR_BUCKETS.soonestMaxMs) return 'soonest';
  if (msToExpiry <= TENOR_BUCKETS.hourMaxMs) return 'hour';
  if (msToExpiry <= TENOR_BUCKETS.todayMaxMs) return 'today';
  return null;
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
  /** Scoring detail (binary): the snapped strike (USD) the mint actually used, so a
   *  settled position can be marked won/lost later. Absent on a simulated pick. */
  strike?: number;
  /** Scoring detail (range): the band edges (USD), same purpose as `strike`. */
  lower?: number;
  higher?: number;
  /** Marking detail — carried onto the open position so live PnL uses the SAME math
   *  as the rest of the terminal (lib/portfolio/v2). Entry win chance (0..1). */
  entryProb?: number;
  /** Sized notional (DUSDC) — what a win pays before the leverage floor. */
  qty?: number;
  /** All-in entry cost (DUSDC): stake plus the fee charged at mint. */
  cost?: number;
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

/** Health of the machinery Autopilot needs to trade safely. An expired key or a quiet
 *  feed stops the run; low gas only PAUSES it (see autoPauseReason). */
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
  | 'too_close_to_expiry'
  | 'settles_after_session'
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

/** Why Autopilot disarmed itself (terminal). `gas_low` is no longer produced (low gas
 *  pauses the run now, see PauseReason) but stays so runs saved before that still label. */
export type StopReason =
  | 'budget_spent'
  | 'trade_cap_reached'
  | 'duration_elapsed'
  | 'loss_limit'
  | 'session_expired'
  | 'gas_low'
  | 'feed_stall';

/**
 * Why Autopilot is holding rather than trading: a condition the trader can clear
 * without ending the run. Low gas is the one so far. The run used to stop outright
 * here, which threw away the rest of a budget over a few cents of SUI; now it waits,
 * offers a top-up, and picks up on its own once the key can pay for a trade again.
 */
export type PauseReason = 'gas_low';

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
  // Not a trader rule but a house one, and it fails closed: see MIN_TIME_TO_EXPIRY_MS.
  if (!hasTimeToTrade(trade.expiry, now)) return deny('too_close_to_expiry');
  // A null tenor is a market settling beyond any window the trader's rules can name (8-21
  // lists 1-day and 1-week markets). It is denied here rather than defaulted into 'today',
  // so nothing fires unattended on a horizon nobody opted into.
  const tenor = classifyTenor(trade.expiry - now);
  if (tenor === null || !rules.tenors.includes(tenor)) return deny('tenor_not_allowed');
  // After the tenor check on purpose: a market outside the trader's windows is refused
  // for that reason first, so the log names the rule they set rather than the clock.
  if (!fitsSession(trade.expiry, runtime.armedAt, limits.armDurationMs)) return deny('settles_after_session');
  if (!rules.sides.includes(trade.side)) return deny('side_not_allowed');
  if (trade.leverage > rules.maxLeverage) return deny('leverage_too_high');

  // --- pacing (these clear on their own; the run stays armed) ---
  if (runtime.openCount >= limits.maxConcurrent) return deny('max_concurrent_reached');
  if (runtime.lastTradeAt != null && now - runtime.lastTradeAt < limits.cooldownMs) {
    return deny('cooldown_active');
  }
  // One bet per market per run. This used to be "not within the cooldown", which came
  // to the same thing on a venue of 1-minute markets. On the 5-minute ladder it let
  // Kelly stack a second bet on the market she had just bet (2026-09-04), so a run's
  // "2 open at a time" were two copies of one view of the same five minutes.
  if (runtime.firedMarkets[trade.marketId] != null) return deny('market_recently_fired');

  return ALLOW;
}

/** The smallest trade the chain accepts: its $1 minimum net premium (see
 *  lib/sui/v2/quote MIN_STAKE_BASE). The budget stop and the last-trade sizing both key
 *  off it: a run keeps going while at least this much is left to place. */
export const MIN_TRADE_USD = 1;

/**
 * How much the next trade stakes: the per-trade size, or whatever is left of the budget
 * once that is smaller.
 *
 * A $5,000 budget split three ways came out at $1,667 a trade, and two of those left
 * $1,666: less than a full trade, but a third of the money the trader put up. The run
 * stopped there and called it "Budget used up". The last trade shrinks to the remainder
 * instead, so the budget is the thing that gets spent, not the rounding.
 *
 * The other direction too: whatever this trade would leave behind that is smaller than
 * the chain's minimum could never be placed by anyone, so it is folded into this trade
 * rather than stranded. That is how $1,666.67 x 3 lands on $5,000.00 exactly instead of
 * a run that ends a few cents short of the budget it was given. Never more than that:
 * a leftover big enough to be a trade is the trader's per-trade size holding, not dust.
 */
export function stakeFor(limits: AutopilotLimits, runtime: AutopilotRuntime): number {
  const remaining = Math.max(0, limits.budgetUsd - runtime.spentUsd);
  const stake = Math.min(limits.perTradeUsd, remaining);
  const leftover = remaining - stake;
  const sized = leftover > 0 && leftover < MIN_TRADE_USD ? remaining : stake;
  // Cents, so a stake that came from float arithmetic is the number the log shows.
  return Math.round(sized * 100) / 100;
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
  if (!health.feedFresh) return 'feed_stall';
  if (runtime.consecutiveLosses >= limits.maxConsecutiveLosses) return 'loss_limit';
  if (runtime.tradeCount >= limits.maxTrades) return 'trade_cap_reached';
  // Nothing left to place once what remains cannot fund even the smallest trade. NOT
  // "another full trade": the last one shrinks to the remainder (see stakeFor), so a
  // budget that does not divide evenly by the per-trade size still gets spent.
  if (limits.budgetUsd - runtime.spentUsd < MIN_TRADE_USD) return 'budget_spent';
  if (now - runtime.armedAt >= limits.armDurationMs) return 'duration_elapsed';
  return null;
}

/**
 * Decide whether Autopilot should HOLD (not stop) on this tick. Checked after
 * autoStopReason, so a run that is out of time or out of key still ends cleanly even
 * while it is waiting on gas. A paused run resumes the moment this returns null.
 */
export function autoPauseReason(health: AutopilotHealth): PauseReason | null {
  if (!health.gasOk) return 'gas_low';
  return null;
}

/** Plain-language reason Autopilot is holding, for the banner + log. */
export function pauseReasonLabel(reason: PauseReason): string {
  switch (reason) {
    case 'gas_low':
      return 'Trading key is low on gas';
  }
}

/**
 * Score a settled position against the settlement price (USD) — did it win?
 * Mirrors the receipt scorer (lib/walrus/receipts.ts::scoreCall): an UP wins when
 * settlement is above the strike, a DOWN wins at/below it, and a range wins when
 * settlement lands in (lower, higher]. Pure, so the loss-limit logic is testable
 * without a chain read. The caller supplies the settlement price from on-chain.
 */
export function settleOutcome(
  pos: { side: TradeSide; strike?: number; lower?: number; higher?: number },
  settlementPrice: number,
): boolean {
  if (pos.side === 'range') {
    return settlementPrice > (pos.lower ?? 0) && settlementPrice <= (pos.higher ?? 0);
  }
  const above = settlementPrice > (pos.strike ?? 0);
  return pos.side === 'up' ? above : !above;
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
    case 'too_close_to_expiry':
      return 'Held back: too close to settling to place a bet';
    case 'settles_after_session':
      return 'Held back: settles after your session ends';
    case 'tenor_not_allowed':
      return 'Held back: outside your allowed windows';
    case 'side_not_allowed':
      return 'Held back: that direction is off';
    case 'leverage_too_high':
      return 'Held back: over your leverage cap';
    case 'cooldown_active':
      return 'Waiting: cooling down between trades';
    case 'market_recently_fired':
      return 'Skipped: already traded this market';
    case 'max_concurrent_reached':
      return 'Waiting: at your open-positions limit';
  }
}

/**
 * How a stop READS to the trader: a planned finish vs something worth attention.
 * Budget, trade cap, and duration are the run doing exactly what you set it to (a
 * clean completion). Key/gas/feed trouble and the losing-streak guard are stops you
 * want flagged. Drives the banner tone so a normal finish never looks like an error.
 */
export function stopReasonKind(reason: StopReason): 'complete' | 'attention' {
  switch (reason) {
    case 'budget_spent':
    case 'trade_cap_reached':
    case 'duration_elapsed':
      return 'complete';
    case 'loss_limit':
    case 'session_expired':
    case 'gas_low':
    case 'feed_stall':
      return 'attention';
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
      return 'Trading key ran low on gas';
    case 'feed_stall':
      return 'Paused: the price feed went quiet';
  }
}
