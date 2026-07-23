/**
 * lib/copilot/close-match.ts — match a "close my bet" request to the trader's
 * actual positions. Pure (no fetch, no signing): the screen passes the closeable
 * positions + the parsed selector, and this decides which to close, whether to
 * ask (ambiguous), or that none match. The screen then runs the redeem.
 */
import { num } from '@/lib/format';
import type { BetDirection } from './intents';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';

export interface CloseSelector {
  /** "close all" / "close everything". */
  all?: boolean;
  /** "redeem my winnings" — only settled winners. */
  winnings?: boolean;
  dir?: BetDirection;
  /** A specific strike the trader named ("close the 65k one"). */
  strike?: number;
}

export interface CloseMatch {
  /** close = act on `positions`; ask = ambiguous, list `positions` and ask; none = nothing matched. */
  action: 'close' | 'ask' | 'none';
  positions: V2PortfolioPosition[];
}

/**
 * Decide what to close. `closeable` is already filtered to redeemable rows (real,
 * with a market + order id + quantity). An explicit "all"/"winnings" acts on the
 * whole matched set; a single match closes directly; anything else that leaves
 * more than one asks which.
 */
export function matchPositionsToClose(closeable: V2PortfolioPosition[], sel: CloseSelector): CloseMatch {
  let m = closeable;
  if (sel.winnings) m = m.filter((p) => p.settled && p.won !== false);
  const dir = sel.dir === 'up' ? 'Up' : sel.dir === 'down' ? 'Down' : null;
  if (dir) m = m.filter((p) => p.direction === dir);
  if (sel.strike != null) {
    const tol = Math.max(50, sel.strike * 0.005);
    m = m.filter((p) => p.strike != null && Math.abs(p.strike - sel.strike!) <= tol);
  }

  if (m.length === 0) return { action: 'none', positions: [] };
  if (m.length === 1) return { action: 'close', positions: m };
  // Explicit bulk request → act on all of them; otherwise it's ambiguous.
  if (sel.all || sel.winnings) return { action: 'close', positions: m };
  return { action: 'ask', positions: m };
}

/** A short label for listing a position: "UP $65,000 · won, ready to redeem". */
export function positionCloseLabel(p: V2PortfolioPosition): string {
  const dir = p.direction === 'Down' ? 'DOWN' : p.direction === 'Up' ? 'UP' : 'Range';
  const where = p.direction === 'Range' && p.band ? `$${num(p.band.lower, 0)}–$${num(p.band.higher, 0)}` : p.strike != null ? `$${num(p.strike, 0)}` : '';
  const state = !p.settled ? 'open' : p.won === false ? 'lost, can clear' : 'won, ready to redeem';
  return `${dir} ${where} · ${state}`.replace('  ', ' ');
}
