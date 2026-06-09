'use client';

/**
 * useCopyTrade — the copy-trade handoff. Pre-fills the surface/trade ticket with
 * a market copied from another trader's position, then routes to the trade page.
 *
 * The trade ticket (flow-panel) reads its market from the Zustand surface-store,
 * which is a module singleton that survives client navigation — so we set the
 * selection here and `router.push('/')`, and the ticket on `/` picks it up. The
 * surface page never auto-overwrites selection on mount, so the copy survives.
 *
 * This copies the MARKET only (oracle / expiry / strike / direction), not size
 * or entry price — the follower sets their own quantity and pays the current
 * chain quote. Callers must gate on the oracle still being tradeable (see
 * TraderPositionsList); a copy onto a settled/expired oracle would silently fall
 * back to a different market in the ticket.
 */
import { useRouter } from 'next/navigation';
import { useSurfaceStore } from '@/lib/store/surface-store';

export interface CopyBinary {
  oracleId: string;
  expiry: number;
  strikeScaled: string; // 1e9-scaled
  strike: number; // float
  isUp: boolean;
}

export interface CopyRange {
  oracleId: string;
  expiry: number;
  lowerScaled: string; // 1e9-scaled
  lower: number; // float
  higherScaled: string;
  higher: number;
}

export function useCopyTrade() {
  const router = useRouter();
  const select = useSurfaceStore((s) => s.select);
  const setTicketMode = useSurfaceStore((s) => s.setTicketMode);
  const clearRange = useSurfaceStore((s) => s.clearRange);
  const pickRangeStrike = useSurfaceStore((s) => s.pickRangeStrike);

  function copyBinary(p: CopyBinary) {
    setTicketMode('binary');
    select({
      oracleId: p.oracleId,
      expiry: p.expiry,
      strikeScaled: p.strikeScaled,
      strike: p.strike,
      isUp: p.isUp,
    });
    router.push('/#trade-ticket');
  }

  function copyRange(p: CopyRange) {
    setTicketMode('range');
    clearRange();
    // Two picks on the same oracle/expiry form the band (sorted internally).
    pickRangeStrike({ oracleId: p.oracleId, expiry: p.expiry, strikeScaled: p.lowerScaled, strike: p.lower });
    pickRangeStrike({ oracleId: p.oracleId, expiry: p.expiry, strikeScaled: p.higherScaled, strike: p.higher });
    router.push('/#trade-ticket');
  }

  return { copyBinary, copyRange };
}
