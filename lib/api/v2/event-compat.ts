/**
 * event-compat.ts — one place that translates a raw Move event payload into the field
 * names the rest of the app has always read.
 *
 * The 8-21 republish renamed and reordered fields inside the event structs we fold
 * everything from. The dangerous part is that NONE of it throws. We read these payloads by
 * name, so a renamed field is simply `undefined`, and every consumer funnels that through
 * `Number(x ?? 0)`. `OrderMinted.net_premium` becoming `premium` does not break a page; it
 * makes every stake, every volume figure, every leaderboard point, and every cost basis
 * read as ZERO, on a board that still looks perfectly healthy. That is the same failure
 * mode as the `strike: 0` bug in the seed capture, and it is why this file exists.
 *
 * The alternative was renaming the field in all eleven consumers. This seam was chosen
 * instead for two reasons: it keeps a single deployment-shaped concern in a single tested
 * file, and it means the leaderboard, portfolio, analytics and co-pilot code is byte for
 * byte what it is today, so the migration cannot change a number on screen.
 *
 * The mapping is SHAPE-driven, not flag-driven: it fires when the new field is present and
 * the old one is not. Reading `V2_IS_821_PLUS` here would mean a mis-set env var silently
 * zeroes the board, which is exactly the outcome being defended against. Running the wrong
 * flag should be survivable; reading a payload we do not understand should not be silent.
 *
 * Verified against the live 8-06 and 8-21 package ABIs on 2026-08-31 (see
 * lib/sui/v2/abi-drift.live.test.ts, which is how this list was produced).
 */
import type { V2Market } from './types';

/** 1e9-scaled 1.0 — the identity leverage. 8-21 removed leverage from the protocol, so
 *  every position on it is unlevered and the downstream math must be a no-op, not a 0. */
export const UNIT_LEVERAGE = 1_000_000_000;

type Json = Record<string, unknown>;

/**
 * Normalize one `order_events` payload.
 *
 * 8-06 → 8-21 changes this undoes:
 *   OrderMinted           net_premium → premium, minted_at_ms → onchain_timestamp_ms,
 *                         leverage removed
 *   LiveOrderRedeemed     redeemed_at_ms → onchain_timestamp_ms
 *   SettledOrderRedeemed  redeemed_at_ms → onchain_timestamp_ms, and quantity_closed and
 *                         settlement_price removed entirely (a settled claim is now
 *                         all-or-nothing, so there is no partial quantity to report)
 *
 * The absent `quantity_closed` is deliberately NOT filled in. Every consumer already reads
 * it as `n(e.quantity_closed) || totalQty`, which resolves an absent quantity to the full
 * position — precisely the all-or-nothing semantic 8-21 moved to. Inventing a number here
 * would replace a correct fallback with a guess. The one place that lacked that fallback,
 * `foldOpenPositions`, was fixed at the fold instead.
 */
export function normalizeOrderEvent(raw: Json, kind: string): Json {
  const out: Json = { ...raw };

  // The stake. The single most damaging rename: silently zeroes every money figure.
  if (out.net_premium == null && out.premium != null) out.net_premium = out.premium;

  // Event time. 8-21 gave every event struct the same `onchain_timestamp_ms` name in place
  // of a per-struct one. Consumers fall back to `checkpoint_timestamp_ms`, so a miss here
  // degrades to the indexer's time rather than to 0, but the event's own stamp is better.
  if (out.onchain_timestamp_ms != null) {
    if (kind === 'order_minted') out.minted_at_ms ??= out.onchain_timestamp_ms;
    else out.redeemed_at_ms ??= out.onchain_timestamp_ms;
  }

  // Unlevered by construction on 8-21. Present as 1x rather than absent so the portfolio's
  // leverage math stays an identity and the ticket never renders a blank or a 0x.
  if (out.leverage == null) out.leverage = UNIT_LEVERAGE;

  return out;
}

/**
 * Normalize a `config_events::MarketCreated` payload.
 *
 * 8-21 dropped the four leverage/liquidation knobs from the market record, because the
 * protocol no longer has leverage or liquidation. `V2Market` still declares them, and the
 * ticket, co-pilot and discovery layers still read them, so they are filled with the values
 * that make that code a no-op:
 *
 *   max_admission_leverage → 1x, which makes `leverageSliderMax` cap at 1 and matches the
 *     standing rule that we quote everything at 1x anyway.
 *   liquidation_ltv → 0, which is what `knockoutProbability` and `priceMoveToKnockout`
 *     already treat as "no barrier" (they return null for ltv <= 0 OR leverage <= 1, so at
 *     1x the whole knockout block is inert without touching a line of the ticket).
 *
 * Leaving them undefined would give `toFloat(undefined)` → NaN and put NaN into the slider
 * bounds, so a default is required, not merely tidy.
 */
export function normalizeMarketCreated(raw: Json): Json {
  const out: Json = { ...raw };
  out.max_admission_leverage ??= UNIT_LEVERAGE;
  out.liquidation_ltv ??= 0;
  out.no_leverage_window_ms ??= 0;
  out.trading_loss_rebate_rate ??= 0;
  return out;
}

/**
 * Normalize an `oracle_lane::OracleRead` (the `lane.latest` node on a PythFeed object, and
 * the same shape inside observation events).
 *
 * 8-21 renamed `update_timestamp_ms` to `onchain_timestamp_ms`. That value is the chart's
 * live-edge stamp and the input to the stale-feed detector, so losing it does not blank the
 * price — it makes a perfectly healthy feed look infinitely stale.
 */
export function oracleReadTimestamp(latest: Json): number {
  return Number(latest.onchain_timestamp_ms ?? latest.update_timestamp_ms ?? 0);
}

/** True when a settled redeem carries no quantity, i.e. the 8-21 all-or-nothing claim that
 *  closes whatever remains of the position. */
export function isFullSettledClose(kind: string, quantityClosed: unknown): boolean {
  return kind === 'settled_order_redeemed' && quantityClosed == null;
}

/** Market-shaped normalization for a already-typed row (the on-chain state reader builds a
 *  `V2Market` directly rather than from an event payload). */
export function withMarketDefaults(m: Partial<V2Market>): Partial<V2Market> {
  return normalizeMarketCreated(m as Json) as Partial<V2Market>;
}
