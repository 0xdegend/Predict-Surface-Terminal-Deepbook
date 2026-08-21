import { TradeBodySkeleton } from '@/app/_components/trade-skeleton';

/**
 * Route-level loading UI for the Latest terminal (`/v2`).
 *
 * WHY THE ROUTE GROUP. Without a loading boundary the App Router has nothing to show
 * while the page's server work runs, so it holds the PREVIOUS screen on-screen until the
 * new one is completely ready — which is what made Simple ⇄ Advanced feel like a dead
 * tap rather than a toggle. This page needs ~1.3s warm (a market list + status read, then
 * a wave of on-chain pricer simulations that can only start once the list is in).
 *
 * A `loading.tsx` at `app/v2/` would have covered every nested route too, flashing this
 * terminal shape in front of Portfolio, Vault and the rest. The `(terminal)` group scopes
 * it to this page alone and leaves the URL as `/v2`.
 *
 * Body only: the chrome and dock live in the v2 layout and stay mounted across the swap.
 */
export default function Loading() {
  return <TradeBodySkeleton />;
}
