'use client';

/**
 * usePositionCashflow — the authoritative per-position cost/payout roll-up from
 * the indexer (`/markets/:m/positions/:root/cashflow`). Server-aggregated across
 * a position's mints + redeems, so it's the ground truth for a CLOSED position's
 * cost basis and realized PnL.
 *
 * Returns `null` while the position is still open (nothing settled yet), so
 * callers keep the client-side order derivation as the fallback. Fetch-on-demand
 * and cached — gate `enabled` to settled rows so it isn't fanned across a list.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPositionCashflow, qkV2 } from '@/lib/api/v2/client';
import { fromQuote } from '@/config/scale';
import type { V2PositionCashflow } from '@/lib/api/v2/types';

export interface PositionCashflow {
  /** Premium + mint fees (DUSDC). */
  costBasis: number;
  /** Live-close proceeds (net of fees) + settled payout (DUSDC). */
  payout: number;
  /** payout − costBasis (DUSDC, signed). */
  netPnl: number;
  raw: V2PositionCashflow;
}

function derive(cf: V2PositionCashflow): PositionCashflow {
  const costBasis = fromQuote(cf.net_premium) + fromQuote(cf.mint_fees);
  const payout =
    fromQuote(cf.settled_payout) + fromQuote(cf.live_redeem_amount) - fromQuote(cf.live_redeem_fees);
  return { costBasis, payout, netPnl: payout - costBasis, raw: cf };
}

export function usePositionCashflow(marketId?: string, root?: string, enabled = true) {
  const q = useQuery<V2PositionCashflow | null>({
    queryKey: qkV2.positionCashflow(marketId ?? '', root ?? ''),
    queryFn: () => getPositionCashflow(marketId!, root!),
    enabled: enabled && !!marketId && !!root,
    staleTime: 60_000,
  });
  const data = useMemo(() => (q.data ? derive(q.data) : null), [q.data]);
  return { data, isLoading: q.isLoading };
}
