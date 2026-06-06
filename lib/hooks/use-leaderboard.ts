'use client';

/**
 * useLeaderboard — the trader leaderboard data spine. Two-stage (see
 * lib/leaderboard/aggregate.ts for the why):
 *
 *   Stage 1: one fetch each of the global minted/redeemed streams + the manager
 *     list → volume & activity rows. Complete and accurate within the window.
 *   Stage 2: fetch authoritative PnL summaries for the managers of the top
 *     `ENRICH_OWNERS` rows (bounded concurrency) and fold them in. PnL ranks
 *     among the most active accounts; the methodology is shown in the UI.
 *
 * Everything is server-data only (no wallet), so it works for any visitor.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getManagers,
  getManagerSummary,
  getManagerPositions,
  getPositionsMinted,
  getPositionsRedeemed,
  PredictApiError,
  qk,
} from '@/lib/api/client';
import {
  aggregateLeaderboard,
  attachEnrichment,
  type LeaderboardRow,
  type ManagerEnrichment,
} from '@/lib/leaderboard/aggregate';
import { derivePortfolioHistory } from '@/lib/portfolio/history';
import { fromQuote } from '@/config/scale';

/** Event-window depth pulled for the volume/activity board. */
const EVENT_LIMIT = 2000;
/** How many top-by-volume owners get authoritative PnL + win-rate enrichment. */
export const ENRICH_OWNERS = 50;
/** Hard cap on enriched managers — bounds the per-manager fetch fan-out. */
const MAX_ENRICH_MANAGERS = 120;
/**
 * Parallel manager fetches. Deliberately gentle: the public server starts
 * dropping/returning non-JSON under a sustained burst, and a swallowed failure
 * silently leaves a top row un-enriched (the "…" PnL/win bug). Kept low so the
 * retry below rarely has to fire. See RETRY_TRIES.
 */
const CONCURRENCY = 4;
/** Per-manager retry budget for transient (rate-limit / parse) failures. */
const RETRY_TRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient = worth retrying: rate limits, 5xx, and parse/network errors
 *  (no status). A genuine 4xx (e.g. 404) is permanent — don't hammer it. */
function isTransient(err: unknown): boolean {
  if (err instanceof PredictApiError) return err.status === 429 || err.status >= 500;
  return true; // SyntaxError from a truncated body, network blips, aborts
}

/** Run `fn` with exponential backoff + jitter on transient failures. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < RETRY_TRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i === RETRY_TRIES - 1 || !isTransient(err)) break;
      await sleep(150 * 2 ** i + Math.random() * 120);
    }
  }
  throw last;
}

/**
 * Fetch per-manager enrichment (summary → PnL, positions → win/loss) with a
 * bounded worker pool and per-manager retries. Win/loss reuses the canonical
 * portfolio derivation so the leaderboard and portfolio never disagree. A
 * manager that still fails after all retries is skipped.
 */
async function fetchEnrichment(ids: string[]): Promise<Map<string, ManagerEnrichment>> {
  const out = new Map<string, ManagerEnrichment>();
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const [summary, positions] = await withRetry(() =>
          Promise.all([getManagerSummary(id), getManagerPositions(id)]),
        );
        const { stats } = derivePortfolioHistory(positions);
        out.set(id, {
          realizedPnl: fromQuote(summary.realized_pnl),
          unrealizedPnl: fromQuote(summary.unrealized_pnl),
          accountValue: fromQuote(summary.account_value),
          openPositions: summary.open_positions ?? 0,
          wins: stats.wins,
          decided: stats.total,
        });
      } catch {
        /* skip — a missing fetch just leaves that row un-enriched */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return out;
}

export interface UseLeaderboard {
  rows: LeaderboardRow[];
  baseLoading: boolean;
  pnlLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useLeaderboard(): UseLeaderboard {
  const baseQ = useQuery({
    queryKey: qk.leaderboardBase,
    queryFn: async () => {
      const [managers, minted, redeemed] = await Promise.all([
        getManagers(5000),
        getPositionsMinted(EVENT_LIMIT),
        getPositionsRedeemed(EVENT_LIMIT),
      ]);
      return aggregateLeaderboard(minted, redeemed, managers);
    },
    staleTime: 30_000,
  });

  const base = useMemo(() => baseQ.data ?? [], [baseQ.data]);

  // Manager ids of the top contenders → the stage-2 enrichment set (capped).
  const enrichIds = useMemo(
    () => base.slice(0, ENRICH_OWNERS).flatMap((r) => r.managerIds).slice(0, MAX_ENRICH_MANAGERS),
    [base],
  );
  const idKey = enrichIds.join(',');

  const enrichQ = useQuery({
    queryKey: qk.leaderboardPnl(idKey),
    queryFn: () => fetchEnrichment(enrichIds),
    enabled: enrichIds.length > 0,
    staleTime: 30_000,
  });

  const rows = useMemo(
    () => (enrichQ.data ? attachEnrichment(base, enrichQ.data) : base),
    [base, enrichQ.data],
  );

  return {
    rows,
    baseLoading: baseQ.isLoading,
    pnlLoading: enrichQ.isFetching,
    error: baseQ.error instanceof Error ? baseQ.error.message : null,
    refetch: () => {
      baseQ.refetch();
      enrichQ.refetch();
    },
  };
}
