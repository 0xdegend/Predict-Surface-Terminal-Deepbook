'use client';

/**
 * useV2PricingOutage — is the protocol refusing to quote ANY live market?
 *
 * Not the same question as "is the price feed up". On 2026-09-18 the Pyth spot feed and both
 * block-scholes stores were writing every second and agreeing with each other, while every
 * live market aborted the protocol's own `pricing::assert_inputs_pricing_safe`. The chart
 * ticked happily and nothing could be traded, so the stale-feed overlay never fired and the
 * ticket sat on "Loading live price…" as though the read were still in flight.
 *
 * COSTS NOTHING. It observes the SAME `qkV2.pricer(id)` cache entries that useV2Pricer and
 * useV2Pricers already populate, with `enabled: false`, so it issues no requests of its own
 * and simply reads the status those queries put there.
 *
 * WHY IT ASKS ABOUT EVERY MARKET, not the selected one. The 9-12 ladder is 1m and 5m only, so
 * the selected market rolls constantly; a per-market signal would blink out every time a new
 * market's query started pending, and a banner that flickers once a minute teaches people to
 * ignore it. Requiring "something has actually failed AND nothing anywhere has priced" keeps
 * it steady through a roll, and clears the moment any market quotes again.
 */
import { useQueries } from '@tanstack/react-query';
import { qkV2 } from '@/lib/api/v2/client';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function useV2PricingOutage(marketIds: string[]): boolean {
  const results = useQueries({
    queries: marketIds.map((id) => ({
      queryKey: qkV2.pricer(id),
      // Observe only. The ticket's 5s poll and the picker's 20s poll own the fetching.
      enabled: false,
      // A cached success must still count as "priced", so keep the data shape.
      select: (d: LivePricer) => d,
    })),
  });
  if (!marketIds.length) return false;
  // "At least one real failure" rules out the first paint, where everything is merely
  // pending. "Nothing has data" rules out a single unlucky market while the rest quote.
  return results.some((r) => r.isError) && results.every((r) => !r.data);
}
