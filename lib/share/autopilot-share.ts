/**
 * Autopilot session share cards: the pure data model + the X post copy.
 *
 * When a run finishes and its last trade settles, the log clears and the trader is
 * offered the run as a card to post. This module turns a saved `RunResult` into the
 * numbers those cards paint and the words that go with them, and says which cards
 * make sense for a given run (a curve needs at least two settled trades, a best
 * call needs at least one win). Kept free of browser / canvas imports so the copy
 * and the gating are unit-tested, same as options-share.
 */
import type { RunResult, RunTradeResult } from '@/lib/store/autopilot-store';
import { buildEquityCurve } from '@/lib/autopilot/equity';
import { stopReasonLabel } from '@/lib/autopilot/policy';
import { PRESET_BY_ID } from '@/lib/autopilot/presets';
import { money } from './options-share';

export type SessionShareKind = 'session' | 'curve' | 'best_trade';

/** The one trade a card can single out. */
export interface SessionShareTrade {
  side: RunTradeResult['side'];
  strike?: number;
  lower?: number;
  higher?: number;
  /** Stake put in (DUSDC). */
  stake: number;
  /** Win chance at entry (0..1). */
  entryProb: number;
  /** Realized PnL (DUSDC, signed). */
  pnlUsd: number;
}

export interface SessionShareData {
  /** Realized PnL for the run (DUSDC, signed). */
  netUsd: number;
  wins: number;
  losses: number;
  /** Trades still awaiting settlement (0 once the run has fully settled). */
  pending: number;
  tradeCount: number;
  /** Over settled trades only, or null before any settle. */
  winRate: number | null;
  /** How long the run was armed for. */
  durationMs: number;
  budgetUsd: number;
  /** Sum of every stake the run put in (DUSDC). */
  stakedUsd: number;
  /** The best WINNING trade, or null when nothing won. */
  best: SessionShareTrade | null;
  /** Worst peak-to-trough fall of the running total, as a positive number. */
  maxDrawdownUsd: number;
  /** Running total after each settled trade, oldest first (no leading zero). */
  curve: number[];
  settledCount: number;
  /** True for a watch-mode (simulated) run. */
  dryRun: boolean;
  /** Why the run ended, in plain words. */
  endedWhy: string;
  /** The style the run followed (Careful / Balanced / Bold), or null when customized. */
  planName: string | null;
  endedAt: number;
}

/** Signed dollars with cents: +$4.20, -$1.50, +$0.00. Matches the run screens. */
export function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

/** "42 minutes", "1h 12m", "2 hours", "under a minute". */
export function durationWords(ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (r === 0) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${h}h ${r}m`;
}

/** "UP above $79,600", "DOWN below $79,600", "$79,000 to $80,000 range". */
export function tradeWords(t: SessionShareTrade): string {
  if (t.side === 'range') return `${money(t.lower ?? 0)} to ${money(t.higher ?? 0)} range`;
  return `${t.side === 'up' ? 'UP above' : 'DOWN below'} ${money(t.strike ?? 0)}`;
}

/** The numbers the cards paint, from a saved run. */
export function buildSessionShare(r: RunResult): SessionShareData {
  const curve = buildEquityCurve(r.trades);
  const won = r.trades.filter((t) => t.outcome === 'won');
  const bestTrade = won.length > 0 ? won.reduce((a, b) => (b.pnlUsd > a.pnlUsd ? b : a)) : null;
  const resolved = r.wins + r.losses;
  return {
    netUsd: r.realizedPnlUsd,
    wins: r.wins,
    losses: r.losses,
    pending: r.pendingCount,
    tradeCount: r.tradeCount,
    winRate: resolved > 0 ? r.wins / resolved : null,
    durationMs: Math.max(0, r.endedAt - r.armedAt),
    budgetUsd: r.budgetUsd,
    stakedUsd: r.trades.reduce((a, t) => a + t.stake, 0),
    best: bestTrade
      ? {
          side: bestTrade.side,
          strike: bestTrade.strike,
          lower: bestTrade.lower,
          higher: bestTrade.higher,
          stake: bestTrade.stake,
          entryProb: bestTrade.entryProb,
          pnlUsd: bestTrade.pnlUsd,
        }
      : null,
    maxDrawdownUsd: curve.maxDrawdown,
    curve: curve.points.slice(1).map((p) => p.cum),
    settledCount: curve.count,
    dryRun: r.dryRun,
    endedWhy: r.stopReason === 'manual' ? 'You stopped it' : stopReasonLabel(r.stopReason),
    planName: r.preset ? PRESET_BY_ID[r.preset].name : null,
    endedAt: r.endedAt,
  };
}

/** Which cards a run can fill: the session always, the curve once it has a shape,
 *  the best call once something won. */
export function sessionShareKinds(d: SessionShareData): SessionShareKind[] {
  const kinds: SessionShareKind[] = ['session'];
  if (d.settledCount >= 2) kinds.push('curve');
  if (d.best) kinds.push('best_trade');
  return kinds;
}

/** "5 trades, 3W/2L, +$4.20" (plus how many are still settling, if any). */
function recordWords(d: SessionShareData): string {
  const trades = `${d.tradeCount} trade${d.tradeCount === 1 ? '' : 's'}`;
  const settling = d.pending > 0 ? `, ${d.pending} still settling` : '';
  return `${trades}, ${d.wins}W/${d.losses}L, ${fmtUsd(d.netUsd)}${settling}`;
}

/** The X post text for a card. Plain language, no em-dashes, tagged @skew_sui.
 *  The image itself is attached by the modal (copy-then-paste); this is the words. */
export function sessionShareText(d: SessionShareData, kind: SessionShareKind): string {
  const dur = durationWords(d.durationMs);
  switch (kind) {
    case 'session':
      return d.dryRun
        ? `I let Kelly paper-trade on Skew Autopilot for ${dur} (watch mode, no real money): ${recordWords(d)}. ` +
            `Every pick was scored against the real market 🦊\n\nTry it on @skew_sui 👇`
        : `Kelly ran my Skew Autopilot for ${dur}: ${recordWords(d)}. ` +
            `Every trade was picked and placed on its own, no popups, while I was away 🦊\n\nSet yours up on @skew_sui 👇`;
    case 'curve': {
      const dip = d.maxDrawdownUsd > 0 ? `worst dip ${fmtUsd(-d.maxDrawdownUsd)}` : 'never went underwater';
      const watch = d.dryRun ? ' Watch mode, no real money.' : '';
      return (
        `My Skew Autopilot session, trade by trade: ${fmtUsd(d.netUsd)} over ${d.settledCount} settled trades in ${dur}, ${dip}.${watch}\n\n` +
        `See how Kelly trades on @skew_sui 👇`
      );
    }
    case 'best_trade': {
      const t = d.best;
      if (!t) return sessionShareText(d, 'session');
      const how = d.dryRun ? 'scored it against the real market' : 'the session key placed it while I was away';
      return (
        `Best call of my Skew Autopilot session: ${tradeWords(t)} with ${Math.round(t.entryProb * 100)}% odds at entry, ` +
        `${fmtUsd(t.pnlUsd)} on a ${money(t.stake)} stake. Kelly picked it and ${how} 🦊\n\nSet yours up on @skew_sui 👇`
      );
    }
  }
}
