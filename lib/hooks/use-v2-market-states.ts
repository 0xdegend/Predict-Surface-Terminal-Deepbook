'use client';

/**
 * useV2MarketStates — the full `/markets/:id/state` for a SET of markets, keyed
 * by market id. Each state carries BOTH the market's creation snapshot (tick
 * size, expiry — needed to turn a position's ticks into a strike price) AND its
 * `settlement` (present once it settles).
 *
 * Why per-market and not the bulk `/markets` list: that list only returns the
 * current/active markets, so an EXPIRED market a position still references has
 * rolled off it — the position then can't be joined to its strike/expiry and
 * sits as a data-less "LIVE" card forever. Fetching each position's own market
 * state fixes the join and gives us the settlement to resolve win/loss.
 *
 * Bounded by design — callers pass only their own positions' markets. Settlement
 * is terminal, so once it lands the value is fixed; we poll gently until then.
 */
import { useQueries } from '@tanstack/react-query';
import { getV2MarketState, qkV2 } from '@/lib/api/v2/client';
import type { V2MarketState } from '@/lib/api/v2/types';

export function useV2MarketStates(marketIds: string[]): Record<string, V2MarketState> {
  const results = useQueries({
    queries: marketIds.map((id) => ({
      queryKey: qkV2.marketState(id),
      queryFn: () => getV2MarketState(id),
      refetchInterval: 15_000,
      staleTime: 10_000,
    })),
  });

  const out: Record<string, V2MarketState> = {};
  marketIds.forEach((id, i) => {
    const d = results[i]?.data;
    if (d) out[id] = d;
  });
  return out;
}
