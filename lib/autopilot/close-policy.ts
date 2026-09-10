// Autopilot early-close policy — the pure decision for exiting a LIVE position
// before its market settles. A companion to gateTrade() in ./policy: gateTrade
// decides whether to OPEN a bet, this decides whether to CLOSE one Kelly already
// holds while the market is still live (redeem_live on-chain; the session variant
// lets Autopilot do it unattended, the same key it mints with).
//
// WHY this exists (founder, 2026-09-10): a bet that is winning midway can still
// flip by the close, and the venue settles on the price AT expiry. Autopilot used
// to have no way to bank a good-profit position — it could only wait for expiry,
// so a position deep in profit with two minutes left rode all the way into a
// late reversal and settled a loss. The trade page already lets a PERSON close a
// live position early (redeem_live, the "Close" button); this gives Kelly the same
// hand while unattended, on a rule, so she takes profit the read says is at risk
// and cuts a loser the read says will not come back.
//
// It is READ-DRIVEN, not a fixed take-profit line. The founder was explicit: while
// the market is still in our favour Kelly holds and lets it run; she only banks
// when her read turns against the side she is holding. The one hard number is a
// deep-in-the-money floor, where a position is so close to its max payout that the
// remaining upside is not worth the downside of a flip, and she takes it whatever
// the read says.
//
// Kept pure (no wallet, no network, no React), like ./policy, so every branch is
// unit-tested before a real close is ever signed. The engine computes the live
// read (mark, fair win chance, lean) from the pricer and hands it in; the actual
// close is quoted on-chain before it fires, exactly as a mint is.

import type { TradeSide } from './policy';
import { MIN_TIME_TO_EXPIRY_MS } from './policy';

/** The market's current directional read, as the engine already computes it for
 *  opening bets (lib/insights/market-read `recommendation().pick`). 'slight' is a
 *  soft lean; only 'clear' is treated as a real turn (see leanTurnedAgainst). */
export interface LeanRead {
  pick: 'up' | 'down' | 'range';
  confidence: 'slight' | 'clear';
}

/**
 * A live position reduced to the numbers the close decision needs. The engine
 * derives these each tick from the position and the live pricer:
 *   markFrac  — current mark value ÷ the position's max payout (0..1). At 1.0 the
 *               position is worth its full winning payout already.
 *   inProfit  — current mark value is above the all-in entry cost.
 *   leanAgainst — the market's read has turned CLEARLY against the side held (see
 *               leanTurnedAgainst); a sideways or merely-slight read is never this.
 *   timeLeftMs — expiry minus now.
 */
export interface OpenRead {
  side: TradeSide;
  markFrac: number;
  inProfit: boolean;
  leanAgainst: boolean;
  timeLeftMs: number;
}

/** Why Autopilot is closing a live position early, or holding it. */
export type CloseCode =
  | 'hold'
  | 'lock_deep_itm'
  | 'take_profit_adverse'
  | 'cut_loss_no_recover';

export interface CloseConfig {
  /** At or above this fraction of max payout, bank it regardless of the read: the
   *  upside left is thin and a flip would give back a lot. The founder's "80% or
   *  higher, regardless". */
  deepItmFrac: number;
  /** Below this much time left, never close: settlement is imminent, and a settled
   *  WINNER is auto-redeemed by the protocol keeper with no close-side builder fee,
   *  so holding to expiry is strictly cheaper than closing here. */
  minTimeMs: number;
  /** A loser is only cut with at least this much time left. "If we still have time
   *  in the market" — near the end a losing binary may revert by expiry and its
   *  max loss is already the premium, so paying a fee to lock the loss is worse
   *  than letting it settle. Comfortably above minTimeMs. */
  cutMinTimeMs: number;
}

export const DEFAULT_CLOSE_CONFIG: CloseConfig = {
  deepItmFrac: 0.8,
  minTimeMs: Math.max(MIN_TIME_TO_EXPIRY_MS, 60_000),
  cutMinTimeMs: 120_000,
};

/**
 * Has the market's read turned against the side we are holding, clearly enough to
 * act on? Only a 'clear' read counts — a 'slight' lean or an uncertain/sideways
 * read leaves the position alone, which is the founder's "Kelly has read the market
 * to not move sideways after" before cutting, and "still in our favour, keep it
 * open" before banking.
 *
 * For a directional bet, "against" is a clear lean the OTHER way. For a band, it is
 * a clear directional break either way, since a range wins by BTC staying put and a
 * confident up/down read is the market leaving the band.
 */
export function leanTurnedAgainst(side: TradeSide, lean: LeanRead | null): boolean {
  if (!lean || lean.confidence !== 'clear') return false;
  if (side === 'range') return lean.pick !== 'range';
  return lean.pick === (side === 'up' ? 'down' : 'up');
}

/**
 * Should Autopilot close this live position now? Returns the reason, or 'hold'.
 * First match wins, most protective first:
 *
 *   1. Too close to settle → hold. Let it settle; a winner is keeper-redeemed free.
 *   2. Deep in the money → bank it, whatever the read says (the one hard number).
 *   3. In profit AND the read has turned clearly against us → bank the profit
 *      before the turn. This is the case the feature was built for.
 *   4. Losing, with time left, AND the read says it will not recover → cut it, so
 *      the residual value is taken before it decays and the read plays out.
 *   5. Otherwise hold: winning with the read still for us (let it run), or losing
 *      but the read is not a clear reversal (it may still come back).
 */
export function closeDecision(read: OpenRead, cfg: CloseConfig = DEFAULT_CLOSE_CONFIG): CloseCode {
  if (read.timeLeftMs < cfg.minTimeMs) return 'hold';
  if (read.markFrac >= cfg.deepItmFrac) return 'lock_deep_itm';
  if (read.inProfit && read.leanAgainst) return 'take_profit_adverse';
  if (!read.inProfit && read.leanAgainst && read.timeLeftMs >= cfg.cutMinTimeMs) return 'cut_loss_no_recover';
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
    case 'take_profit_adverse':
      return 'Closed early: banked profit before a likely turn';
    case 'cut_loss_no_recover':
      return "Closed early: cut a loser the read doesn't see recovering";
  }
}
