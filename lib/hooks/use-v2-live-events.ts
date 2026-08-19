'use client';

/**
 * lib/hooks/use-v2-live-events.ts — turns the shared Predict event stream (push) into
 * TARGETED TanStack invalidations, so live views refresh the instant a trade / settlement
 * / claim lands instead of on their poll interval.
 *
 * Deliberately targeted, never a prefix sweep: an order event invalidates ONLY the one
 * market + one account it names (from the event's own json) plus the single aggregate
 * board — so a trade never fans out into re-fetching every market's (expensive) open
 * interest. invalidateQueries only re-fetches OBSERVED queries, so anything not on screen
 * is a no-op. The per-market OI keeps its own 30s cache (see onchainMarketOpenInterest),
 * so even when it IS invalidated the refetch is cache-bounded.
 *
 * Mount once at the v2 shell. Polling stays as the fallback for when the stream is
 * reconnecting; this only makes the happy path instant.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qkV2 } from '@/lib/api/v2/client';
import { watchPredictEvents, type LiveEvent } from '@/lib/sui/v2/event-stream';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The query keys a single live event should invalidate. Pure + exported for tests.
 * Targeted by the market / account / code the event names; no broad prefixes.
 */
export function eventRefreshTargets(e: LiveEvent): readonly (readonly unknown[])[] {
  const keys: (readonly unknown[])[] = [];
  if (e.module === 'order_events') {
    const market = str(e.json.expiry_market_id);
    const account = str(e.json.account_id);
    if (market) {
      keys.push(qkV2.marketOrders(market), qkV2.marketActivity(market), qkV2.marketOpenInterest(market));
    }
    if (account) {
      keys.push(qkV2.accountOrders(account), qkV2.accountPositions(account));
      // The authoritative settled-value reconciliation (use-v2-portfolio-positions) is keyed
      // ['v2','settled-order-value', account, …]; a prefix invalidation re-runs it, so the
      // keeper's auto-redeem (or clear) drops the resolved position near-instantly instead of
      // waiting for that query's own interval. See [[keeper-redeem-read-gap]].
      keys.push(['v2', 'settled-order-value', account]);
    }
    // The one aggregate board (a live leaderboard is meant to tick on trades).
    keys.push(['v2', 'leaderboard', 'boards']);
  } else if (e.module === 'vault_events') {
    keys.push(qkV2.vaultServerState, qkV2.vaultFlushes, qkV2.vaultProfit, qkV2.vaultFlows);
  } else if (e.module === 'builder_code_events') {
    const code = str(e.json.builder_code_id);
    if (code) keys.push(qkV2.builderCodeFees(code));
  }
  return keys;
}

/**
 * Coalescing window for stream-driven invalidations. A keeper BATCH auto-redeem emits
 * many order events at once (one per settled winner), each targeting the SAME
 * accountPositions/accountOrders key — firing them all invalidates that key N times in a
 * burst, which stacks refetches onto the poll cadence and 429s the public GraphQL proxy.
 * That failed read is exactly what used to flash paid positions back as claimable
 * (see [[keeper-redeem-read-gap]]). Debouncing per key collapses the burst into one
 * refetch a beat after the last event, well under any human-perceptible delay.
 */
const INVALIDATE_DEBOUNCE_MS = 500;

/** Mount once (v2 shell): stream Predict events and invalidate the targeted queries,
 *  coalescing bursts so a keeper batch redeem refetches each key once, not N times. */
export function useV2LiveEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (key: readonly unknown[]) => {
      const id = JSON.stringify(key);
      const pending = timers.get(id);
      if (pending) clearTimeout(pending);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void qc.invalidateQueries({ queryKey: key });
        }, INVALIDATE_DEBOUNCE_MS),
      );
    };
    const stop = watchPredictEvents((e) => {
      for (const key of eventRefreshTargets(e)) schedule(key);
    });
    return () => {
      stop();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [qc]);
}
