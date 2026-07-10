'use client';

/**
 * useV2Settlements — the on-chain settlement price for a SET of ExpiryMarkets,
 * from `/markets/:id/state` (`settlement.settlement_price`, present once a market
 * has settled). Returns a map `marketId → settlement price (float $) | null`.
 *
 * This is what lets an expired position resolve to won/lost: the indexer is slow
 * to report a terminal status and the live pricer stops quoting past expiry, so
 * the portfolio marks the outcome itself off this price (see settleV2Position).
 * Bounded by design — callers pass only their open positions' markets. Settlement
 * is terminal, so once it lands the value is fixed; we poll gently until then.
 */
import { useQueries } from '@tanstack/react-query';
import { getV2MarketState, qkV2 } from '@/lib/api/v2/client';
import { toFloat } from '@/config/scale';

export function useV2Settlements(marketIds: string[]): Record<string, number | null> {
  const results = useQueries({
    queries: marketIds.map((id) => ({
      queryKey: qkV2.marketState(id),
      queryFn: () => getV2MarketState(id),
      refetchInterval: 15_000,
      staleTime: 10_000,
    })),
  });

  const out: Record<string, number | null> = {};
  marketIds.forEach((id, i) => {
    const sp = results[i]?.data?.settlement?.settlement_price;
    out[id] = sp != null ? toFloat(sp) : null;
  });
  return out;
}
