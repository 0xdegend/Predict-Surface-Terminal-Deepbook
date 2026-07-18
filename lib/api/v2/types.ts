/**
 * lib/api/v2/types.ts — response shapes for the NEW (v2) Predict beta indexer
 * and the propbook oracle indexer. Modelled on live responses captured 2026-06-27
 * (see VERIFY notes in [[predict-deployment-6-24]]).
 *
 * Numeric scaling: prices/strikes/probabilities/leverage are 1e9-scaled; DUSDC
 * amounts are 6-dec base units. The indexer returns large integers as STRINGS and
 * ratios/bps as numbers — coerce at the edge (see lib/markets/v2-discovery.ts).
 */

/** A `MarketCreated` event row from `/markets` (one per ExpiryMarket). */
export interface V2Market {
  expiry_market_id: string;
  pool_vault_id: string;
  propbook_underlying_id: number;
  /** Settlement timestamp (ms). */
  expiry: number;
  /** When the market was created (ms) — used to derive the cadence tenor. */
  checkpoint_timestamp_ms: number;
  /** Price/probability tick (1e9-scaled, string). e.g. "10000000" = $0.01. */
  tick_size: string;
  /** Strike admission grid (1e9-scaled, string). e.g. "1000000000" = $1. */
  admission_tick_size: string;
  max_expiry_allocation: string;
  initial_expiry_cash: string;
  /** Liquidation loan-to-value (1e9-scaled). e.g. 850000000 = 0.85. */
  liquidation_ltv: number;
  /** Max leverage at admission (1e9-scaled). e.g. 3000000000 = 3x. */
  max_admission_leverage: number;
  backing_buffer_lambda: number;
  base_fee: string;
  min_fee: string;
  /** Entry probability bounds (1e9-scaled string). e.g. "10000000" = 1%. */
  min_entry_probability: string;
  max_entry_probability: string;
  expiry_fee_window_ms: number;
  expiry_fee_max_multiplier: number;
  trading_loss_rebate_rate: number;
  kind: string; // "market_created"
}

/** `/markets/:id/state` — live overlay on top of the creation snapshot. */
export interface V2MarketState {
  expiry_market_id: string;
  market: V2Market;
  /** Reference ("price to beat") tick once set, else null. 1e9-scaled. */
  reference_tick: number | string | null;
  mint_paused: boolean | null;
  /** Present once the market has settled. */
  settlement: V2Settlement | null;
}

export interface V2Settlement {
  settlement_price?: string;
  settled_at_ms?: number;
  [k: string]: unknown;
}

/** Health response (shared shape between the beta server and propbook indexer). */
export interface V2Status {
  status: string;
  latest_onchain_checkpoint: number;
  current_time_ms: number;
  earliest_checkpoint?: number;
  max_lag_pipeline?: string;
  pipelines?: { pipeline: string; checkpoint_lag: number; time_lag_seconds: number }[];
}

/** `/oracles/:pyth_id/pyth/latest` from the propbook indexer — raw Pyth spot. */
export interface PythObservation {
  propbook_oracle_id: string;
  pyth_source_id: number;
  /** Spot = price_magnitude * 10^(±exponent_magnitude). */
  price_magnitude: string;
  price_is_negative: boolean;
  exponent_magnitude: number;
  exponent_is_negative: boolean;
  source_timestamp_ms?: number;
  checkpoint_timestamp_ms?: number;
}

/**
 * A row from `/accounts/{owner}/positions` (owner-scoped, verified live 2026-06-28
 * — returns 200, empty on testnet). Shape is permissive / best-effort because no
 * populated sample exists yet; the positions panel reads fields defensively and
 * mapping is confirmed once a real account holds positions.
 */
export interface V2Position {
  expiry_market_id?: string;
  market_id?: string;
  order_id?: string | number;
  /** Joins the position to its `order_minted` event (for the fees paid at mint). */
  position_root_id?: string | number;
  lower_tick?: string | number;
  higher_tick?: string | number;
  open_quantity?: string | number;
  quantity?: string | number;
  cost?: string | number;
  total_cost?: string | number;
  mark_value?: string | number;
  pnl?: string | number;
  is_leveraged?: boolean;
  status?: string;
  expiry?: number;
  [k: string]: unknown;
}

/**
 * `/accounts/{account_id}/orders` — the append-only order EVENT log. Each row is
 * one on-chain event, tagged by `kind`. Field names mirror the Move event
 * structs (order_events.move on predict-testnet-6-24):
 *  - `order_minted`             → OrderMinted (mint: quantity, net_premium, ticks…)
 *  - `live_order_redeemed`      → LiveOrderRedeemed (close: redeem_amount, fees…)
 *  - `settled_order_redeemed`   → SettledOrderRedeemed (claim: payout_amount, settlement_price)
 *  - `liquidated_order_redeemed`→ LiquidatedOrderRedeemed (knocked out: zero payout)
 * A closed trade = a `*_redeemed` event joined to its mint by `position_root_id`.
 */
export interface V2OrderEvent {
  kind?: string;
  expiry_market_id?: string;
  account_id?: string;
  owner?: string;
  order_id?: string | number;
  position_root_id?: string | number;
  checkpoint_timestamp_ms?: number;
  // mint (order_minted)
  lower_tick?: string | number;
  higher_tick?: string | number;
  quantity?: string | number;
  net_premium?: string | number;
  entry_probability?: string | number;
  leverage?: string | number;
  // redeem (live/settled/liquidated)
  quantity_closed?: string | number;
  remaining_quantity?: string | number;
  redeem_amount?: string | number; // live close, before fees, after floor
  payout_amount?: string | number; // settled terminal payout
  settlement_price?: string | number;
  trading_fee?: string | number;
  builder_fee?: string | number;
  penalty_fee?: string | number;
  [k: string]: unknown;
}

/** `/oracle-bindings` — maps an underlying to its feed object ids per oracle kind. */
export interface OracleBinding {
  propbook_underlying_id: number;
  /** 0 = pyth, 1 = bs spot, 2 = bs forward, 3 = bs svi. */
  oracle_kind: number;
  source_id: number;
  propbook_oracle_id: string;
}

/* ----- server vault/analytics endpoints (shipped ~2026-07; live-verified 2026-07-08) -----
 * Server convention: Postgres NUMERIC values (amounts, quantities, shares) are
 * JSON STRINGS in 6-dec base units; counts/timestamps are JSON numbers.
 */

/** `current` component of `/vaults/:id/state` — newest per-field vault figures. */
export interface V2VaultCurrent {
  idle_balance_after: string;
  total_supply: string;
  /** Full pool NAV (idle + capital deployed to open markets). Share price = pool_value / total_supply. */
  pool_value: string;
  /** Capital currently backing open markets (pool_value − idle, roughly). */
  active_market_nav: string;
  protocol_reserve_balance_after: string;
  pending_protocol_profit_after: string;
  profit_basis_after: string;
  fee_incentive_reserve_after: string | null;
}

/** The keeper flush that last re-valued the pool (fills execute in the same tx). */
export interface V2VaultFlush {
  checkpoint_timestamp_ms: number;
  epoch: number;
  pool_value: string;
  total_supply: string;
  active_market_nav: string;
  market_count: number;
  supplies_filled: number;
  withdrawals_filled: number;
  requests_processed: number;
  [k: string]: unknown;
}

/** `/vaults/:id/state` — composed latest-by-event reads over the vault tables. */
export interface V2VaultServerState {
  pool_vault_id: string;
  current: V2VaultCurrent | null;
  latest_flush: V2VaultFlush | null;
  [k: string]: unknown;
}

/** `/markets/:id/open-interest` — sums over the market's open order_state rows. */
export interface V2OpenInterest {
  expiry_market_id: string;
  open_order_count: number;
  /** Max payout at risk across open orders (6-dec base units). */
  open_quantity: string;
  open_floor_shares: string;
}

/** One hourly bucket of `/markets/:id/activity` (market_activity_1h MV, 60s refresh). */
export interface V2ActivityBucket {
  expiry_market_id: string;
  bucket_ms: number;
  mint_count: number;
  mint_quantity: string;
  /** Net premium staked by minters in the bucket (6-dec base units). */
  mint_premium: string;
  mint_fees: string;
  unique_minters: number;
  live_redeem_count: number;
  live_redeem_quantity: string;
  live_redeem_amount: string;
  live_redeem_fees: string;
  settled_redeem_count: number;
  settled_redeem_quantity: string;
  settled_redeem_payout: string;
}

/** One hourly bucket of `/markets/:id/liquidation-stats` (liquidation_stats_1h MV). */
export interface V2LiquidationBucket {
  expiry_market_id: string;
  bucket_ms: number;
  liquidated_count: number;
  liquidated_quantity: string;
  gross_value: string;
  floor_amount: string;
  surplus: string;
  gap: string;
}

/* ---- Tier-1 endpoints (predict-testnet-6-24 server, live-verified 2026-07-18).
 * Amounts are 6-dec base units (fromQuote); timestamps are ms numbers. Typed
 * defensively (index signature) so extra fields from a later deploy are ignored. */

/** `/vaults/:id/profit` — realized profit per market settlement (`expiry_profit_materialized`). */
export interface V2VaultProfit {
  checkpoint_timestamp_ms: number;
  expiry_market_id: string;
  /** LP share of realized profit (base units). */
  lp_profit: string;
  /** Protocol share of realized profit (base units). */
  protocol_profit: string;
  /** Running cumulative profit basis after this settlement (base units). */
  profit_basis_after: string;
  [k: string]: unknown;
}

/** `/vaults/:id/flows` — hourly supply/withdraw activity buckets (`vault_flows_1h`). */
export interface V2VaultFlow {
  bucket_ms: number;
  supply_count: number;
  supply_amount: string;
  shares_minted: string;
  withdraw_count: number;
  withdraw_amount: string;
  shares_burned: string;
  /** Total PLP shares outstanding after this bucket (base units). */
  total_supply_after: string;
  idle_balance_after: string;
  [k: string]: unknown;
}

/** `/builder-codes/:id/fees` — builder-fee CLAIM events for a code (`builder_fees_claimed`). */
export interface V2BuilderFee {
  builder_code_id: string;
  /** Amount swept in this claim (DUSDC base units). */
  amount: string;
  checkpoint_timestamp_ms: number;
  [k: string]: unknown;
}

/**
 * `/markets/:expiry_market_id/positions/:position_root_id/cashflow` — the
 * authoritative per-position cost/payout roll-up (server-aggregated across the
 * position's mints + redeems). Returns `null` while the position is still open
 * (nothing settled yet), so callers must tolerate null and fall back to the
 * client-side order derivation. All amounts are 6-dec base units.
 */
export interface V2PositionCashflow {
  expiry_market_id: string;
  position_root_id: string;
  account_id: string;
  owner: string;
  /** Max payout the position was opened for. */
  minted_quantity: string;
  /** Premium paid to open (cost basis). */
  net_premium: string;
  mint_fees: string;
  /** Proceeds + fees + quantity from any pre-expiry closes. */
  live_redeem_amount: string;
  live_redeem_fees: string;
  live_quantity_closed: string;
  /** Terminal payout + quantity settled at expiry. */
  settled_payout: string;
  settled_quantity_closed: string;
  /** Quantity knocked out by liquidation (pays 0). */
  liquidated_quantity_closed: string;
  [k: string]: unknown;
}
