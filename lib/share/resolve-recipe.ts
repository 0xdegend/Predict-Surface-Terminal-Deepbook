/**
 * lib/share/resolve-recipe.ts — turn a shared TradeRecipe (see trade-link.ts) into a
 * concrete, tradeable selection against the CURRENT live markets. This is the piece
 * that makes a link survive Skew's sub-minute expiries: the sender's exact market is
 * long gone, so we re-resolve the recipe's SHAPE (tenor + level + size) onto a fresh
 * market of the same cadence.
 *
 * What it does, and deliberately does not:
 *  - Picks the soonest still-mintable market of the recipe's tenor (falling back to
 *    the soonest of any tenor, with a note, if that family has none right now).
 *  - Snaps the strike / band edges onto that market's admission grid.
 *  - Clamps leverage to what the market admits.
 *  - Records plain-language `adjustments` for anything it changed, so the recipient
 *    UI can say "moved to fit this market".
 *
 * It does NOT clamp the strike into the SVI-quotable probability band. That needs the
 * live pricer and, more importantly, clamping would silently rewrite the sender's
 * intent. If price has run past the level, the honest outcome is the ticket showing
 * the (now extreme) live odds, or its existing "too far to price" guard disabling the
 * mint. Quotability stays chain-authoritative at the ticket, exactly like copy-trade.
 *
 * Pure and deterministic (`now` injectable), so it is fully unit-testable.
 */
import type { V2Market } from '@/lib/api/v2/types';
import { activeMarkets, cadenceOf, isTooCloseToExpiry, maxLeverageX, CADENCE_LABEL } from '@/lib/markets/v2-discovery';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { toFloat, fromFloat } from '@/config/scale';
import type { TradeRecipe, RecipeMode } from './trade-link';

export interface ResolvedTrade {
  marketId: string;
  mode: RecipeMode;
  /** binary direction. */
  isUp?: boolean;
  /** binary strike (snapped), or null to follow the current at-the-money. */
  strike: number | null;
  /** range band edges (snapped). */
  lower?: number;
  higher?: number;
  /** The sender's stake, carried through (the ticket re-checks it against balance). */
  stake: number;
  /** Leverage, clamped to the market's max. */
  lev: number;
  /** Plain-language notes on anything changed from the sender's exact recipe. */
  adjustments: string[];
}

export type ResolveResult =
  | { ok: true; trade: ResolvedTrade; market: V2Market }
  | { ok: false; reason: 'no_market' };

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/** Re-resolve a recipe onto the current live markets. `now` injectable for tests. */
export function resolveRecipe(recipe: TradeRecipe, markets: V2Market[], now: number = Date.now()): ResolveResult {
  // Only markets a mint can still safely land in before expiry.
  const tradeable = activeMarkets(markets, now).filter((m) => !isTooCloseToExpiry(m, now));
  if (!tradeable.length) return { ok: false, reason: 'no_market' };

  const adjustments: string[] = [];

  // Soonest still-mintable market of the requested tenor; else the soonest overall.
  let market = tradeable.find((m) => cadenceOf(m) === recipe.tenor);
  if (!market) {
    market = tradeable[0];
    adjustments.push(
      `No live ${recipe.tenor} market right now, so this opens on the ${CADENCE_LABEL[cadenceOf(market)].toLowerCase()} market instead.`,
    );
  }

  const admisTick = market.admission_tick_size;
  const snap = (p: number) => toFloat(snapStrikeToAdmission(fromFloat(p), admisTick));

  // Leverage can only go as high as the market admits.
  const maxLev = maxLeverageX(market);
  const lev = Math.min(recipe.lev, maxLev);
  if (lev < recipe.lev) adjustments.push(`Leverage set to this market's max of ${maxLev}x.`);

  const trade: ResolvedTrade = {
    marketId: market.expiry_market_id,
    mode: recipe.mode,
    stake: recipe.stake,
    lev,
    strike: null,
    adjustments,
  };

  if (recipe.mode === 'binary') {
    trade.isUp = recipe.isUp;
    if (recipe.strike != null) {
      const s = snap(recipe.strike);
      trade.strike = s;
      // Only mention a move the eye would notice (a coarse grid), not sub-dollar snapping.
      if (Math.abs(s - recipe.strike) >= 1) adjustments.push(`Strike moved to ${usd(s)} to fit this market's grid.`);
    }
    // strike stays null when the recipe omitted it → the ticket follows the ATM.
  } else {
    const lo = snap(recipe.lower!);
    const hi = snap(recipe.higher!);
    if (hi <= lo) {
      // Both edges snapped to the same tick: widen to the smallest tradeable band.
      trade.lower = lo;
      trade.higher = lo + toFloat(admisTick);
      adjustments.push('Range widened to the smallest tradeable band on this market.');
    } else {
      if (Math.abs(lo - recipe.lower!) >= 1 || Math.abs(hi - recipe.higher!) >= 1) {
        adjustments.push(`Range moved to ${usd(lo)} to ${usd(hi)} to fit this market's grid.`);
      }
      trade.lower = lo;
      trade.higher = hi;
    }
  }

  return { ok: true, trade, market };
}
