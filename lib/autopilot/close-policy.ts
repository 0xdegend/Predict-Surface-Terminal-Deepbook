// Autopilot early-close policy — the pure decision for exiting a LIVE position
// before its market settles. A companion to gateTrade() in ./policy: gateTrade
// decides whether to OPEN a bet, this decides whether to CLOSE one Kelly already
// holds while the market is still live (redeem_live on-chain; the session variant
// lets Autopilot do it unattended, the same key it mints with).
//
// WHY this exists (founder, 2026-09-10): a bet winning midway can still flip by the
// close, and the venue settles on the price AT expiry. Autopilot used to only wait
// for expiry, so a position deep in profit with two minutes left rode into a late
// reversal and settled a loss. The trade page already lets a PERSON close a live
// position early (redeem_live, the "Close" button); this gives Kelly the same hand
// while unattended, on a rule.
//
// It is STYLE-AWARE (founder, 2026-09-10): the three presets treat closing
// differently, and the config carries the knobs (see CLOSE_CONFIG in ./presets):
//   - Careful banks solid gains early and stops out big losses, to preserve capital,
//     accepting that some stopped positions would have reverted.
//   - Balanced is read-driven with a near-certain-win lock and a soft magnitude stop.
//   - Bold rides every position to settlement (its config disables every trigger):
//     a binary's downside is already capped at its premium, so "don't close" is a
//     coherent style, not a reckless one.
//
// One mechanic drives the loss side: these are binary/range OPTIONS bought for a
// premium, so a position can never lose more than it cost. A "stop loss" here is not
// about runaway downside — it salvages the residual value of a decaying position
// before expiry and frees the slot.
//
// Kept pure (no wallet, no network, no React), like ./policy, so every branch is
// unit-tested before a real close is ever signed. The engine computes the live read
// (mark, gain-on-cost, lean) from the pricer and hands it in; the actual close is
// quoted on-chain before it fires, exactly as a mint is.

import type { TradeSide } from './policy';
import { MIN_TIME_TO_EXPIRY_MS } from './policy';

/** The market's current directional read, as the engine already computes it for
 *  opening bets (lib/insights/market-read `recommendation()`). 'slight' is a soft
 *  lean; only 'clear' is treated as a real turn (see leanTurnedAgainst). */
export interface LeanRead {
  pick: 'up' | 'down' | 'range';
  confidence: 'slight' | 'clear';
}

/**
 * A live position reduced to the numbers the close decision needs. The engine derives
 * these each tick from the position and the live pricer:
 *   markFrac   — current mark value ÷ the position's max payout (0..1). At 1.0 the
 *                position is already worth its full winning payout.
 *   gainOnCost — unrealized PnL as a SIGNED fraction of what was paid: +0.30 = up 30%
 *                on the stake, -0.40 = down 40%. The take-profit and stop-loss triggers
 *                read this so they mean the same thing to a person ("up 30%, take it").
 *   leanAgainst — the market read has turned CLEARLY against the side held (see
 *                leanTurnedAgainst); a sideways or merely-slight read is never this.
 *   timeLeftMs — expiry minus now.
 */
export interface OpenRead {
  side: TradeSide;
  markFrac: number;
  gainOnCost: number;
  leanAgainst: boolean;
  timeLeftMs: number;
}

/** Why Autopilot is closing a live position early, or holding it. */
export type CloseCode =
  | 'hold'
  | 'lock_deep_itm'
  | 'take_profit_target'
  | 'take_profit_adverse'
  | 'stop_loss'
  | 'cut_loss_no_recover';

/**
 * The knobs a preset sets for closing (see CLOSE_CONFIG in ./presets). A `null` on any
 * of the three thresholds disables that trigger; Bold sets all three to null and
 * `useRead` false, which makes closeDecision always hold (it rides to expiry).
 */
export interface CloseConfig {
  /** Bank when the gain reaches this fraction of cost (0.30 = +30% on the stake). */
  takeProfitOnCost: number | null;
  /** Bank regardless of the read at/above this fraction of MAX PAYOUT (a near-certain
   *  win, where the upside left is thin and a flip would give back a lot). */
  deepItmFrac: number | null;
  /** Cut when the loss reaches this fraction of cost (0.40 = -40% on the stake), to
   *  salvage the residual before it decays to nothing. */
  stopLossOnCost: number | null;
  /** Whether the read-driven bank/cut rules apply at all. Bold rides, so false. */
  useRead: boolean;
  /** Below this much time left, never close: settlement is imminent and a settled
   *  WINNER is auto-redeemed by the keeper with no close-side builder fee, so holding
   *  to expiry is strictly cheaper than closing here. */
  minTimeMs: number;
  /** A LOSS (magnitude stop or read-driven cut) is only taken with at least this much
   *  time left: near the end a losing binary may revert by expiry and its max loss is
   *  already the premium, so paying a fee to lock the loss is worse than settling. */
  cutMinTimeMs: number;
}

/** The Balanced knobs, and the fallback for a Custom run that matches no preset. */
export const DEFAULT_CLOSE_CONFIG: CloseConfig = {
  takeProfitOnCost: null,
  deepItmFrac: 0.8,
  stopLossOnCost: 0.6,
  useRead: true,
  minTimeMs: Math.max(MIN_TIME_TO_EXPIRY_MS, 60_000),
  cutMinTimeMs: 120_000,
};

/**
 * Has the market's read turned against the side we are holding, clearly enough to act
 * on? Only a 'clear' read counts — a 'slight' lean or an uncertain/sideways read leaves
 * the position alone, which is the founder's "read the market to not move sideways
 * after" before cutting, and "still in our favour, keep it open" before banking.
 *
 * For a directional bet, "against" is a clear lean the OTHER way. For a band, it is a
 * clear directional break either way, since a range wins by BTC staying put and a
 * confident up/down read is the market leaving the band.
 */
export function leanTurnedAgainst(side: TradeSide, lean: LeanRead | null): boolean {
  if (!lean || lean.confidence !== 'clear') return false;
  if (side === 'range') return lean.pick !== 'range';
  return lean.pick === (side === 'up' ? 'down' : 'up');
}

/**
 * Should Autopilot close this live position now? Returns the reason, or 'hold'. First
 * match wins, most protective first:
 *
 *   1. Too close to settle → hold. Let it settle; a winner is keeper-redeemed free.
 *   2. Deep in the money → bank it whatever the read says (a near-certain win).
 *   3. Hit the profit target (gain on cost) → bank it. Careful's early take-profit.
 *   4. In profit AND the read turned clearly against us → bank before the turn.
 *   5. Hit the stop loss (loss on cost), with time left → cut it. Careful's stop.
 *   6. Losing, with time left, AND the read says no recovery → cut it.
 *   7. Otherwise hold: winning with the read still for us, or losing but no clear
 *      reversal (it may come back). Bold disables 2-6, so it always lands here.
 */
export function closeDecision(read: OpenRead, cfg: CloseConfig = DEFAULT_CLOSE_CONFIG): CloseCode {
  if (read.timeLeftMs < cfg.minTimeMs) return 'hold';
  if (cfg.deepItmFrac != null && read.markFrac >= cfg.deepItmFrac) return 'lock_deep_itm';
  if (cfg.takeProfitOnCost != null && read.gainOnCost >= cfg.takeProfitOnCost) return 'take_profit_target';
  if (cfg.useRead && read.gainOnCost > 0 && read.leanAgainst) return 'take_profit_adverse';
  if (cfg.stopLossOnCost != null && read.gainOnCost <= -cfg.stopLossOnCost && read.timeLeftMs >= cfg.cutMinTimeMs) return 'stop_loss';
  if (cfg.useRead && read.gainOnCost <= 0 && read.leanAgainst && read.timeLeftMs >= cfg.cutMinTimeMs) return 'cut_loss_no_recover';
  return 'hold';
}

/** Whether a code actually closes the position (everything but 'hold'). */
export function isClose(code: CloseCode): boolean {
  return code !== 'hold';
}

/** Plain-language run-log line for a close, mirroring gateReasonLabel in ./policy. */
export function closeReasonLabel(code: CloseCode): string {
  switch (code) {
    case 'hold':
      return 'Holding: the read still favours this position';
    case 'lock_deep_itm':
      return 'Closed early: locked in most of the payout';
    case 'take_profit_target':
      return 'Closed early: banked the profit target';
    case 'take_profit_adverse':
      return 'Closed early: banked profit before a likely turn';
    case 'stop_loss':
      return 'Closed early: stopped the loss before it grew';
    case 'cut_loss_no_recover':
      return "Closed early: cut a loser the read doesn't see recovering";
  }
}
