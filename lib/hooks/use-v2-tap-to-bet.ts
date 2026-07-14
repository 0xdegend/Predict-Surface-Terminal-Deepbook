'use client';

/**
 * useV2TapToBet — the analytics "tap a market to bet it" action for the new
 * deployment (legacy's copyBinary role). The trade selection lives in the global
 * v2 store, so we set the market + side there and route to the Trade screen, which
 * reads the store and opens pre-filled. Strike is left to follow ATM (the ticket
 * defaults to the at-the-money grid strike until the trader picks one).
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import type { MarketCell } from '@/lib/analytics/v2-aggregate';

export function useV2TapToBet() {
  const router = useRouter();
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);

  return useCallback(
    (cell: MarketCell) => {
      selectMarket(cell.marketId);
      // Pre-fill the side the crowd is leaning — the actionable read.
      setIsUp(cell.upShare >= 0.5);
      router.push('/v2');
    },
    [selectMarket, setIsUp, router],
  );
}
