'use client';

/**
 * useV2CopyTrade — the copy-trade handoff for the new deployment (legacy's
 * useCopyTrade). Pre-fills the v2 trade ticket with a market copied from another
 * trader's open position, then routes to the Trade screen.
 *
 * The ticket reads its selection from the module-singleton v2-trade-store, which
 * survives client navigation, so we set the market + side + level here and
 * `router.push('/v2')`; the Trade screen picks it up pre-filled. `markPicked`
 * bumps pickSeq so the ticket jumps straight to the bet step (a fresh external
 * pick, exactly like tapping a market card).
 *
 * This copies the MARKET only (which market, direction, strike/band) — NOT size,
 * leverage, or entry price. The follower sets their own stake and pays the current
 * chain quote. Callers must gate on the market still being live (see
 * V2TraderPositionsList): pinning a settled/expired market lands the follower on a
 * market that can't be quoted.
 */
import { useRouter } from 'next/navigation';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';

export interface CopyV2Binary {
  marketId: string;
  /** Absolute strike (float $). */
  strike: number;
  isUp: boolean;
}

export interface CopyV2Range {
  marketId: string;
  /** Absolute band edges (float $). */
  lower: number;
  higher: number;
}

export function useV2CopyTrade() {
  const router = useRouter();
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setMode = useV2TradeStore((s) => s.setMode);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const setRangeBand = useV2TradeStore((s) => s.setRangeBand);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);

  function copyBinary(p: CopyV2Binary) {
    // selectMarket clears any pinned strike/band, so set the level AFTER it.
    selectMarket(p.marketId, true);
    setMode('binary');
    setIsUp(p.isUp);
    setStrikePrice(p.strike);
    markPicked();
    openTicketSheet(); // mobile: surface the slide-up ticket
    router.push('/v2');
  }

  function copyRange(p: CopyV2Range) {
    selectMarket(p.marketId, true);
    setMode('range');
    setRangeBand(p.lower, p.higher); // sorted internally
    markPicked();
    openTicketSheet();
    router.push('/v2');
  }

  return { copyBinary, copyRange };
}
