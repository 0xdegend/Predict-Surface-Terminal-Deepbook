'use client';

/**
 * useV2OpenSharedTrade — the recipient side of a shared trade link. Given a decoded
 * TradeRecipe (from the /t/<token> route), it fetches the current markets, re-resolves
 * the recipe onto a live market (see resolve-recipe.ts), pre-fills the v2 trade ticket
 * exactly like copy-trade does, and routes to /v2 so the ticket opens ready to place.
 *
 * It is the copy-trade handoff (useV2CopyTrade) plus two things copy-trade omits: it
 * carries the sender's STAKE and LEVERAGE, and it re-resolves the recipe because the
 * sender's original market has almost certainly expired (Skew markets are sub-minute).
 *
 * Like copy-trade it only pre-fills — it never signs. The ticket re-quotes on-chain and
 * the recipient confirms. Returns the resolution outcome (adjustments + sender ref) so
 * the landing/ticket can show "your friend set this up" and any "moved to fit" notes.
 */
import { useRouter } from 'next/navigation';
import { getV2Markets } from '@/lib/api/v2/client';
import { resolveRecipe } from '@/lib/share/resolve-recipe';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import type { TradeRecipe } from '@/lib/share/trade-link';

export type OpenSharedResult =
  | { ok: true; adjustments: string[]; ref?: string }
  | { ok: false; reason: 'no_market' };

/**
 * Is a live market currently available for this recipe, with enough runway to place?
 * The landing page calls this on mount so it can show a "this market has closed" state
 * upfront instead of a button that dead-ends. A plain module function (no hooks) so it
 * is a stable import. The actual open re-resolves authoritatively, so a market that
 * rolls between this check and the tap is still handled by openSharedTrade.
 */
export async function checkSharedTradeAvailable(recipe: TradeRecipe): Promise<boolean> {
  try {
    const markets = await getV2Markets(100);
    return resolveRecipe(recipe, markets).ok;
  } catch {
    return false;
  }
}

export function useV2OpenSharedTrade() {
  const router = useRouter();
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setMode = useV2TradeStore((s) => s.setMode);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const setRangeBand = useV2TradeStore((s) => s.setRangeBand);
  const setStake = useV2TradeStore((s) => s.setStake);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const openTicketSheet = useV2TradeStore((s) => s.openTicketSheet);
  const setSharedContext = useV2TradeStore((s) => s.setSharedContext);

  /**
   * Resolve + apply the recipe, then route to the pre-filled ticket. Pass
   * `navigate: false` to only apply the store (e.g. when already on /v2).
   */
  async function openSharedTrade(recipe: TradeRecipe, opts?: { navigate?: boolean }): Promise<OpenSharedResult> {
    // A server/feed outage should degrade to the same graceful "no live market"
    // fallback as an all-expired shape, never an unhandled rejection.
    let markets;
    try {
      markets = await getV2Markets(100);
    } catch {
      return { ok: false, reason: 'no_market' };
    }
    const res = resolveRecipe(recipe, markets);
    if (!res.ok) return { ok: false, reason: res.reason };

    const t = res.trade;
    // selectMarket clears any pinned strike/band, so set the level AFTER it.
    selectMarket(t.marketId, true);
    setMode(t.mode);
    if (t.mode === 'binary') {
      setIsUp(t.isUp ?? true);
      if (t.strike != null) setStrikePrice(t.strike); // else follow the ATM
    } else if (t.lower != null && t.higher != null) {
      setRangeBand(t.lower, t.higher);
    }
    setStake(t.stake);
    setLeverage(t.lev);
    markPicked(); // jump the ticket to the bet step, like a fresh external pick
    openTicketSheet(); // mobile: surface the slide-up ticket
    // Set AFTER selectMarket (which clears it) so the banner shows on the ticket.
    setSharedContext({ ref: recipe.ref, adjustments: t.adjustments });

    if (opts?.navigate !== false) router.push('/v2');
    return { ok: true, adjustments: t.adjustments, ref: recipe.ref };
  }

  return { openSharedTrade };
}
