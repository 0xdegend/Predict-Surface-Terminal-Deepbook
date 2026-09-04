/**
 * seed-merge.ts — fold a fresh leaderboard capture into the snapshot already on disk.
 *
 * A capture reads the chain, and the chain reads are WINDOWED. Owner discovery walks the
 * newest few hundred builder-code opt-in events and the global scan saturates after a few
 * days, so a wallet that traded a week ago and has been quiet since is simply not in a
 * fresh read. Found on 2026-09-04: re-capturing 8-06 four days after the first snapshot
 * returned 521 wallets, but 104 wallets from the earlier snapshot (238 trades) were not
 * among them, every one last active 6 to 8 days before. Nothing had changed on chain;
 * the read had moved on. A seed built from that capture alone would have quietly dropped
 * them at cutover, which is the exact loss the capture exists to prevent.
 *
 * So the previous snapshot is a third source, merged with the same rule the capture
 * already uses between its two live paths: per owner, the row with MORE trades wins,
 * whole. That is sound for the same reason it is sound there: every row was built from
 * events filtered on the exact builder code, so no source can over-count, and the larger
 * count is the more complete read of the same trader. History is a union by row key,
 * fresh rows winning on a tie, so a re-derived row replaces its older copy rather than
 * sitting beside it.
 *
 * Pure and data-free. The capture test wires it; the seed registry never needs it.
 */
import type { PastPrediction } from '@/lib/portfolio/history';
import { mergeHistoryRows } from '@/lib/portfolio/legacy-history';

/** One row of a points seed file, the shape written by the capture. */
export interface SeedRow {
  owner: string;
  points: number;
  volume: number;
  trades: number;
  netPnl: number;
  skewVolume: number;
  skewTrades: number;
  lastActiveMs: number;
}

const lc = (s: string) => s.toLowerCase();

/** Distinct owners of a set of rows, lowercased, in first-seen order. */
export function seedOwners(rows: readonly { owner: string }[]): string[] {
  return [...new Set(rows.map((r) => lc(r.owner)))];
}

/**
 * Per owner, keep whichever row has more trades, whole. A tie goes to the fresh row: it
 * is the newer read of the same record, and its points reflect holding time as of now.
 * Owners only the previous seed knows are kept as they were. Sorted by points, so the
 * result is a board and not just a set.
 */
export function mergeSeedRows<T extends { owner: string; trades: number; points: number }>(
  fresh: readonly T[],
  previous: readonly T[],
): T[] {
  const byOwner = new Map<string, T>();
  for (const r of previous) byOwner.set(lc(r.owner), r);
  for (const r of fresh) {
    const o = lc(r.owner);
    const p = byOwner.get(o);
    if (!p || r.trades >= p.trades) byOwner.set(o, r);
  }
  return [...byOwner.values()].sort((a, b) => b.points - a.points);
}

/**
 * Per owner, the union of both reads' rows, deduplicated by row key with the fresh copy
 * winning. A wallet only the previous seed knows keeps its rows unchanged.
 */
export function mergeSeedHistory(
  fresh: Record<string, PastPrediction[]>,
  previous: Record<string, PastPrediction[]>,
): Record<string, PastPrediction[]> {
  const out: Record<string, PastPrediction[]> = {};
  const owners = new Set([...Object.keys(fresh), ...Object.keys(previous)].map(lc));
  for (const o of owners) {
    const f = fresh[o] ?? [];
    const p = previous[o] ?? [];
    const rows = mergeHistoryRows(f, p);
    if (rows.length) out[o] = rows;
  }
  return out;
}
