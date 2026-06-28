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

/** `/oracle-bindings` — maps an underlying to its feed object ids per oracle kind. */
export interface OracleBinding {
  propbook_underlying_id: number;
  /** 0 = pyth, 1 = bs spot, 2 = bs forward, 3 = bs svi. */
  oracle_kind: number;
  source_id: number;
  propbook_oracle_id: string;
}
