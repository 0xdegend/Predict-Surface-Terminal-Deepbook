/**
 * lib/analytics/market-book.ts — OUR OWN book, folded out of one market's order feed.
 *
 * WHY THIS EXISTS. The Options page had a section called "Positioning & flow" that
 * contained no positioning and no flow of ours: it was Deribit max pain, spot ETF
 * inflows, and an exchange-wide long/short gauge. All real, all third-party, and all
 * describing a horizon measured in days against markets that settle in minutes. The
 * page's actual advantage — a live, continuously quoted book that we can read in
 * full — was sitting unused on a different route.
 *
 * Everything here comes from `/markets/:id/orders`, which is per-mint and complete:
 * trader, direction, strike, premium staked, notional, and the entry probability the
 * trade actually paid. That last field is the interesting one. It is not a model
 * output; it is the price a person accepted, which makes it a genuinely independent
 * read on the same question the surface answers.
 *
 * THE MAX PAIN HERE IS REAL, not borrowed. Deribit's pin is computed the same way and
 * quoted for a monthly expiry; ours is computed over our own open positions for an
 * expiry that may be four minutes out. Settlement above a strike pays the UP side,
 * at-or-below pays the DOWN side, so total payout as a function of settlement price is
 * a step function over the strike grid and its minimum is the price that costs the
 * book least. On a thin market that number is noise, which is why `bets` and
 * `traders` ride alongside it and the UI is expected to gate on them.
 *
 * Scaling, per lib/api/v2/types: premiums and quantities are 6-dec base units
 * (`fromQuote`), entry probability and ticks are 1e9-scaled (`toFloat`).
 *
 * Pure + side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */
import { tickToStrike } from '@/lib/sui/v2/ticks';
import { fromQuote, toFloat } from '@/config/scale';
import { orderSide, type Side } from './v2-aggregate';
import type { V2OrderEvent } from '@/lib/api/v2/types';

/** One direction's standing interest at a strike. */
export interface BookSide {
  /** Premium staked (DUSDC). */
  stakeUsd: number;
  /** Max payout at risk (DUSDC) — the notional the book owes if this side wins. */
  notionalUsd: number;
  bets: number;
  /**
   * Premium-weighted entry probability actually PAID here, or null with no mints.
   * The crowd's price, as distinct from the surface's.
   */
  paidProb: number | null;
}

/** Both sides of one strike. */
export interface BookStrike {
  /** Strike ($). */
  strike: number;
  up: BookSide;
  down: BookSide;
  /** up.stakeUsd + down.stakeUsd — what the UI sizes a bar by. */
  stakeUsd: number;
}

export interface MarketBook {
  /** Strikes carrying interest, ascending. Empty when nothing has been minted. */
  strikes: BookStrike[];
  /** Total premium staked on this market (DUSDC). */
  stakeUsd: number;
  /** Total notional at risk across both sides (DUSDC). */
  notionalUsd: number;
  /** Distinct owners who minted here. */
  traders: number;
  /** Mint count. */
  bets: number;
  /** Premium-weighted UP share (0..1). Range bets excluded. 0.5 when there is none. */
  upShare: number;
  /** The strike carrying the most premium, either side. */
  busiestStrike: number | null;
  /**
   * The settlement price that pays this book the least. Null below `MIN_PAIN_BETS`,
   * because a pin drawn from three positions is a decoration, not a read.
   */
  maxPain: number | null;
  /** Largest single mint by premium. */
  biggest: { stakeUsd: number; side: Side; strike: number | null; trader: string } | null;
  /** Premium on range bets, which have no single strike to sit at. */
  rangeStakeUsd: number;
}

/** Below this many mints, `maxPain` is suppressed rather than shown as a real pin. */
export const MIN_PAIN_BETS = 8;

export const EMPTY_BOOK: MarketBook = {
  strikes: [],
  stakeUsd: 0,
  notionalUsd: 0,
  traders: 0,
  bets: 0,
  upShare: 0.5,
  busiestStrike: null,
  maxPain: null,
  biggest: null,
  rangeStakeUsd: 0,
};

/** A mutable accumulator, folded into BookSide at the end. */
interface SideAcc {
  stakeUsd: number;
  notionalUsd: number;
  bets: number;
  /** Σ premium × entry probability, for the premium-weighted average. */
  probWeighted: number;
  /** Σ premium over mints that actually carried an entry probability. */
  probBasis: number;
}

const newAcc = (): SideAcc => ({ stakeUsd: 0, notionalUsd: 0, bets: 0, probWeighted: 0, probBasis: 0 });

const seal = (a: SideAcc): BookSide => ({
  stakeUsd: a.stakeUsd,
  notionalUsd: a.notionalUsd,
  bets: a.bets,
  paidProb: a.probBasis > 0 ? a.probWeighted / a.probBasis : null,
});

/**
 * The strike a binary mint sits at, in dollars, or null for a range (which spans two
 * and therefore belongs at neither). UP encodes its strike as the lower tick with
 * +∞ above; DOWN as the higher tick with 0 below (see lib/sui/v2/ticks).
 */
function strikeOf(o: V2OrderEvent, side: Side, tickSize: string | bigint): number | null {
  const raw = side === 'up' ? o.lower_tick : side === 'down' ? o.higher_tick : null;
  if (raw == null) return null;
  const strike = toFloat(tickToStrike(BigInt(raw as string | number), BigInt(tickSize)));
  return Number.isFinite(strike) && strike > 0 ? strike : null;
}

/**
 * Fold a market's order events into its book.
 *
 * `tickSize` is the market's own `tick_size` (1e9-scaled), needed to turn tick
 * indices back into prices. Non-mint events (redeems, liquidations) are ignored: this
 * is standing interest at mint, not a settled ledger.
 */
export function buildMarketBook(orders: V2OrderEvent[] | undefined, tickSize: string | bigint): MarketBook {
  if (!orders || orders.length === 0) return EMPTY_BOOK;

  const byStrike = new Map<number, { up: SideAcc; down: SideAcc }>();
  const traders = new Set<string>();
  let stakeUsd = 0;
  let notionalUsd = 0;
  let bets = 0;
  let upStake = 0;
  let downStake = 0;
  let rangeStakeUsd = 0;
  let biggest: MarketBook['biggest'] = null;

  for (const o of orders) {
    if (o.kind !== 'order_minted') continue;
    const stake = fromQuote(Number(o.net_premium ?? 0));
    const notional = fromQuote(Number(o.quantity ?? 0));
    if (!(stake > 0)) continue;

    const side = orderSide(o.lower_tick, o.higher_tick);
    const strike = strikeOf(o, side, tickSize);

    bets += 1;
    stakeUsd += stake;
    notionalUsd += notional;
    if (o.owner) traders.add(o.owner);
    if (side === 'up') upStake += stake;
    else if (side === 'down') downStake += stake;
    else rangeStakeUsd += stake;

    if (!biggest || stake > biggest.stakeUsd) {
      biggest = { stakeUsd: stake, side, strike, trader: o.owner ?? '' };
    }

    // A range bet has no single strike to stand at, so it counts toward the totals
    // and the biggest-bet line but not the per-strike ladder.
    if (side === 'range' || strike == null) continue;

    let row = byStrike.get(strike);
    if (!row) {
      row = { up: newAcc(), down: newAcc() };
      byStrike.set(strike, row);
    }
    const acc = side === 'up' ? row.up : row.down;
    acc.stakeUsd += stake;
    acc.notionalUsd += notional;
    acc.bets += 1;
    const prob = o.entry_probability != null ? toFloat(o.entry_probability) : null;
    if (prob != null && prob > 0 && prob < 1) {
      acc.probWeighted += stake * prob;
      acc.probBasis += stake;
    }
  }

  const strikes: BookStrike[] = [...byStrike.entries()]
    .map(([strike, { up, down }]) => ({
      strike,
      up: seal(up),
      down: seal(down),
      stakeUsd: up.stakeUsd + down.stakeUsd,
    }))
    .sort((a, b) => a.strike - b.strike);

  const directional = upStake + downStake;
  let busiestStrike: number | null = null;
  let best = -1;
  for (const k of strikes) {
    if (k.stakeUsd > best) {
      best = k.stakeUsd;
      busiestStrike = k.strike;
    }
  }

  return {
    strikes,
    stakeUsd,
    notionalUsd,
    traders: traders.size,
    bets,
    upShare: directional > 0 ? upStake / directional : 0.5,
    busiestStrike,
    maxPain: bets >= MIN_PAIN_BETS ? maxPainOf(strikes) : null,
    biggest,
    rangeStakeUsd,
  };
}

/**
 * What the book owes if settlement lands at `price`. UP pays when settlement is
 * strictly ABOVE its strike; DOWN pays at or below. Mirrors the ladder's own
 * "settles on the price at expiry, not a touch" rule.
 */
export function payoutAt(strikes: BookStrike[], price: number): number {
  let owed = 0;
  for (const k of strikes) {
    if (price > k.strike) owed += k.up.notionalUsd;
    else owed += k.down.notionalUsd;
  }
  return owed;
}

/**
 * The settlement price that costs the book least — our own max pain.
 *
 * Payout is a step function that only changes as the price crosses a strike, so the
 * minimum is always attained on one of a small set of candidates: just below the
 * lowest strike, at each strike, and just above the highest. Evaluating those is exact
 * and needs no search. Ties resolve to the lowest candidate, so the answer is stable
 * as the book fills in rather than hopping between equal minima.
 */
export function maxPainOf(strikes: BookStrike[]): number | null {
  if (strikes.length === 0) return null;

  // At a strike, DOWN pays (settlement is not strictly above it). One step below the
  // lowest and one above the highest cover the open ends of the range.
  const step = strikes.length > 1 ? (strikes[strikes.length - 1].strike - strikes[0].strike) / strikes.length : 1;
  const candidates = [strikes[0].strike - step, ...strikes.map((k) => k.strike), strikes[strikes.length - 1].strike + step];

  let bestPrice: number | null = null;
  let bestOwed = Infinity;
  for (const price of candidates) {
    if (!(price > 0)) continue;
    const owed = payoutAt(strikes, price);
    if (owed < bestOwed - 1e-9) {
      bestOwed = owed;
      bestPrice = price;
    }
  }
  return bestPrice;
}

/**
 * What the crowd actually PAID for this exact bet, premium-weighted, or null when
 * nobody has taken that side at that strike.
 *
 * This is the fourth read the probability consensus was missing. The panel's own note
 * says it excludes crowd markets because Polymarket's BTC books are longer-dated than
 * ours — true, and beside the point, because our own book is exactly our horizon by
 * construction. Where the surface says 62% and the money went on at 55%, that gap is
 * the read.
 */
export function paidProbAt(book: MarketBook, strike: number, isUp: boolean): { prob: number; stakeUsd: number } | null {
  const row = book.strikes.find((k) => k.strike === strike);
  if (!row) return null;
  const side = isUp ? row.up : row.down;
  return side.paidProb != null ? { prob: side.paidProb, stakeUsd: side.stakeUsd } : null;
}
