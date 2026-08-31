/**
 * lib/portfolio/legacy-history.ts — merging a wallet's carried-over trade history in.
 *
 * Trade history is derived from the CURRENT deployment's order events, keyed by that
 * deployment's account object, so every redeploy (6-24 → 8-06 → 8-21) leaves a returning
 * trader staring at an empty history tab. We keep it continuous by snapshotting each
 * retiring deployment's fully-derived rows and merging them underneath the live ones.
 *
 * This module is deliberately DATA-FREE so it is safe to import from a client component.
 * The snapshots themselves live in legacy-history-data.ts and are served per wallet by
 * /api/v2/legacy-history — see that file for why nearly a megabyte of JSON must not be
 * bundled into the browser.
 *
 * Matched by wallet address, which is stable across deployments via the same zkLogin
 * wallet, case-insensitive. Applied in useV2History, so it covers the portfolio tab, a
 * trader profile, and Kelly alike.
 */
import type { PastPrediction } from './history';

/** Pure merge: live rows + legacy rows, newest-first, deduped by `key` (live wins).
 *  Returns the input untouched when there's nothing to add. */
export function mergeHistoryRows(live: PastPrediction[], legacy: PastPrediction[]): PastPrediction[] {
  if (legacy.length === 0) return live;
  const seen = new Set(live.map((r) => r.key));
  return [...live, ...legacy.filter((r) => !seen.has(r.key))].sort((a, b) => b.settledAt - a.settledAt);
}

/** Fetch one wallet's carried-over rows. Best-effort: history must still render if the
 *  snapshot route is unreachable, so a failure returns nothing rather than throwing. */
export async function fetchLegacyHistory(owner: string | undefined, signal?: AbortSignal): Promise<PastPrediction[]> {
  if (!owner) return [];
  try {
    const res = await fetch(`/api/v2/legacy-history?owner=${encodeURIComponent(owner)}`, { signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { rows?: PastPrediction[] };
    return json.rows ?? [];
  } catch {
    return [];
  }
}

/** Fetch the full carried-over history keyed by wallet — the admin console's win-rate and
 *  join-curve inputs. Same best-effort contract as the per-wallet read. */
export async function fetchLegacyHistoryByOwner(
  signal?: AbortSignal,
): Promise<Record<string, PastPrediction[]>> {
  try {
    const res = await fetch('/api/v2/legacy-history?all=1', { signal });
    if (!res.ok) return {};
    const json = (await res.json()) as { byOwner?: Record<string, PastPrediction[]> };
    return json.byOwner ?? {};
  } catch {
    return {};
  }
}
