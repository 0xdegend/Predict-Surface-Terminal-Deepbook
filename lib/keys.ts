/**
 * lib/keys.ts — strike-grid math + typed MarketKey / RangeKey PTB builders.
 *
 * Confirmed from source (predict-testnet-4-16):
 *  - market_key::new(oracle_id: ID, expiry: u64, strike: u64, is_up: bool): MarketKey
 *  - range_key::new(oracle_id: ID, expiry: u64, lower: u64, higher: u64): RangeKey
 *  - Grid: strikes are `min_strike + k*tick_size` for k in [0, oracle_strike_grid_ticks].
 *    oracle_strike_grid_ticks = 100_000, so max_strike = min_strike + tick_size*100_000.
 *  - is_up = pays $1 when settlement is ABOVE strike.
 *  - Strikes are 1e9-scaled u64 (same scale as oracle.min_strike / tick_size).
 *
 * All grid math is done in bigint at 1e9 scale to avoid float drift. Convert to
 * a display price with config/scale toFloat.
 */
import type { Transaction, TransactionResult } from '@mysten/sui/transactions';
import { predictConfig } from '@/config/predict';
import type { Oracle } from '@/lib/api/types';

/** Fixed tick count every oracle grid covers (constants::oracle_strike_grid_ticks). */
export const ORACLE_STRIKE_GRID_TICKS = 100_000n;

export interface GridBounds {
  minStrike: bigint; // 1e9-scaled
  maxStrike: bigint; // 1e9-scaled
  tickSize: bigint; // 1e9-scaled
  tickCount: bigint;
}

export function gridBounds(oracle: Oracle): GridBounds {
  const minStrike = BigInt(oracle.min_strike);
  const tickSize = BigInt(oracle.tick_size);
  return {
    minStrike,
    tickSize,
    tickCount: ORACLE_STRIKE_GRID_TICKS,
    maxStrike: minStrike + tickSize * ORACLE_STRIKE_GRID_TICKS,
  };
}

/** True if `strike` (1e9-scaled bigint) lies exactly on the oracle grid. */
export function isValidStrike(strike: bigint, oracle: Oracle): boolean {
  const { minStrike, maxStrike, tickSize } = gridBounds(oracle);
  if (strike < minStrike || strike > maxStrike) return false;
  return (strike - minStrike) % tickSize === 0n;
}

/** Snap an arbitrary 1e9-scaled price to the nearest valid grid strike (clamped). */
export function snapStrikeToTick(strike: bigint, oracle: Oracle): bigint {
  const { minStrike, maxStrike, tickSize } = gridBounds(oracle);
  if (strike <= minStrike) return minStrike;
  if (strike >= maxStrike) return maxStrike;
  const k = (strike - minStrike + tickSize / 2n) / tickSize;
  return minStrike + k * tickSize;
}

/** The k-th grid strike (1e9-scaled). */
export function strikeAtIndex(k: bigint, oracle: Oracle): bigint {
  const { minStrike, tickSize } = gridBounds(oracle);
  return minStrike + k * tickSize;
}

/**
 * A centered window of grid strikes around `centerScaled` (e.g. the forward),
 * snapped to ticks. `half` strikes on each side, `step` ticks apart. Returns
 * 1e9-scaled bigints, ascending, clamped to the grid. Used by the trade ticket
 * and (in Phase 2) the surface strike axis — we never render all 100k ticks.
 */
export function strikeWindow(
  oracle: Oracle,
  centerScaled: bigint,
  half = 12,
  stepTicks = 1n,
): bigint[] {
  const { minStrike, maxStrike, tickSize } = gridBounds(oracle);
  const center = snapStrikeToTick(centerScaled, oracle);
  const stride = tickSize * stepTicks;
  const out: bigint[] = [];
  for (let i = -half; i <= half; i++) {
    const s = center + BigInt(i) * stride;
    if (s >= minStrike && s <= maxStrike) out.push(s);
  }
  return out;
}

/* ----------------------------- PTB builders ----------------------------- */

const KEY_PKG = () => predictConfig.packageId;

export interface MarketKeyInput {
  oracleId: string;
  expiry: number | bigint; // ms epoch (must equal oracle.expiry)
  strike: bigint; // 1e9-scaled, must be on grid
  isUp: boolean;
}

/** Build a `MarketKey` value inside a PTB; returns the moveCall result handle. */
export function buildMarketKey(tx: Transaction, input: MarketKeyInput): TransactionResult {
  return tx.moveCall({
    target: `${KEY_PKG()}::market_key::new`,
    arguments: [
      tx.pure.id(input.oracleId),
      tx.pure.u64(BigInt(input.expiry)),
      tx.pure.u64(input.strike),
      tx.pure.bool(input.isUp),
    ],
  });
}

export interface RangeKeyInput {
  oracleId: string;
  expiry: number | bigint;
  lowerStrike: bigint; // 1e9-scaled
  higherStrike: bigint; // 1e9-scaled, must be > lower
}

/** Build a `RangeKey` value inside a PTB; returns the moveCall result handle. */
export function buildRangeKey(tx: Transaction, input: RangeKeyInput): TransactionResult {
  return tx.moveCall({
    target: `${KEY_PKG()}::range_key::new`,
    arguments: [
      tx.pure.id(input.oracleId),
      tx.pure.u64(BigInt(input.expiry)),
      tx.pure.u64(input.lowerStrike),
      tx.pure.u64(input.higherStrike),
    ],
  });
}
