/**
 * lib/insights/context.ts — the canonical shape of the off-chain market context.
 *
 * Spot, 24h change, open interest, funding, 24h liquidations, options max-pain and
 * sentiment: the wider-market read the intelligence engine weighs the surface's
 * fair probability against. The server route fills it from Clawby; the pure
 * generators (read / recommendation / …) consume it.
 *
 * Defined ONCE here so the route, the client hook, and the engine can never drift
 * apart. This is the fix for the old shape being declared three times (route +
 * hook + a client-only type import). PURE + SERVER-SAFE: no React, no fetch, no
 * browser globals — a Node route or a scheduled job can import it freely.
 *
 * Asset-agnostic by design: every field is generic market context, so the same
 * shape serves BTC today and ETH / RWA later (see ./assets).
 */

export interface MarketContext {
  /** false when the upstream data source has no key / is unreachable — the UI
   *  hides context rather than showing an error. */
  available: boolean;
  /** When this snapshot was built (ms epoch). */
  asOf: number;
  spot: number | null;
  change24hPct: number | null;
  oiUsd: number | null;
  funding: { binancePct: number | null; avgPct: number | null };
  liq24h: { totalUsd: number | null; longUsd: number | null; shortUsd: number | null };
  maxPain: { strike: number; date: string } | null;
  sentiment: { value: number; label: string } | null;
}

/**
 * @deprecated Prefer {@link MarketContext}. Kept as an alias so the many existing
 * `BtcInsights` imports keep resolving while the codebase migrates to the
 * asset-neutral name.
 */
export type BtcInsights = MarketContext;
