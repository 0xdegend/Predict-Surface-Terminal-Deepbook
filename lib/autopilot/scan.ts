/**
 * lib/autopilot/scan.ts — what Kelly actually looked at on a tick.
 *
 * The Stage shows a trader which markets Kelly evaluated and how she rated them. That
 * only earns its place on screen if it is the REAL ranking, so this is a faithful record
 * published BY the engine tick rather than a second scoring pass written for the UI. A
 * display-only re-scoring would drift from the firing path the first time either changed,
 * and then the scene would be showing a deliberation that never happened, which is the
 * one thing a verifiable-track-record app cannot afford to do.
 *
 * Nothing here decides anything. The engine builds this after it has already ranked its
 * picks, and the snapshot is read only by the scene and its caption.
 */
import type { TradeSide } from './policy';

/** One market as Kelly rated it this tick. */
export interface ScanRow {
  marketId: string;
  /** Settlement timestamp (ms), so the scene can sort by urgency and label the tenor. */
  expiry: number;
  /** The win chance being quoted for the shape she would buy (0..1). */
  prob: number;
  /** Value edge behind the pick (0..1). 0 when nothing is mispriced, which is normal. */
  edge: number;
  /** Which shape she would buy here. */
  side: TradeSide;
  /** True when this pick cleared the trader's rules and could actually be bought. */
  clears: boolean;
  /**
   * Log-moneyness of the level she would buy, ln(strike / forward), so the scene can
   * stand her at the actual strike rather than at the money. A range uses its midpoint.
   * 0 when the level is unknown, which reads as at-the-money and is the safe default.
   */
  k: number;
}

/**
 * One tick's evaluation, best value first.
 *
 * `ranked` holds only the picks that CLEARED the trader's rules, in the order the engine
 * would attempt them. `best` is the strongest shape that was offered at all, cleared or
 * not, and it is what keeps the quiet stretches honest: when nothing clears, the scene can
 * still stand Kelly on the market she rates highest and say why she is not buying it,
 * instead of going blank and looking broken.
 */
export interface ScanSnapshot {
  /** When the tick ran (ms epoch). A snapshot is a moment, not a live feed. */
  at: number;
  /** Markets that survived the window/tenor/already-traded filters. */
  consideredCount: number;
  /** Shapes offered across those markets (a market can offer both a binary and a range). */
  offeredCount: number;
  /** Picks that cleared the rules, best value first. Empty when none did. */
  ranked: ScanRow[];
  /** The best shape offered this tick, whether or not it cleared. Null when none was. */
  best: ScanRow | null;
  /** Plain-language reason nothing was bought, when nothing was. */
  holdReason: string | null;
}

/** How long a snapshot is worth showing before it reads as stale (ms).
 *
 *  The tick runs every six seconds, so anything older than a few ticks means the engine
 *  has stopped publishing (paused, stopped, or an exception) and the scene should stop
 *  presenting an old ranking as the current one. */
export const SCAN_FRESH_MS = 20_000;

export function isScanFresh(scan: ScanSnapshot | null, now: number): scan is ScanSnapshot {
  return !!scan && now - scan.at <= SCAN_FRESH_MS;
}

/**
 * The markets worth drawing, most interesting first, capped.
 *
 * Cleared picks outrank held ones (they are what she can actually buy), and within each
 * group the better edge wins, falling back to the sooner expiry the way rankPicks does.
 * The cap is a rendering budget: past about a dozen markers the scene reads as noise and
 * the per-marker labels stop being legible.
 */
export function scanRowsForStage(scan: ScanSnapshot | null, limit = 12): ScanRow[] {
  if (!scan) return [];
  const seen = new Set<string>();
  const rows: ScanRow[] = [];
  for (const r of [...scan.ranked, ...(scan.best ? [scan.best] : [])]) {
    if (seen.has(r.marketId)) continue;
    seen.add(r.marketId);
    rows.push(r);
  }
  return rows
    .sort((a, b) => Number(b.clears) - Number(a.clears) || b.edge - a.edge || a.expiry - b.expiry)
    .slice(0, limit);
}
