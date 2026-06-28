/**
 * lib/sui/v2/ticks.ts — strike ⇄ tick conversion for the v2 range-digital model.
 *
 * A position is a strike RANGE expressed as two tick indices (lower_tick, higher_tick):
 *   price(tick) = tick × tick_size           (both 1e9-scaled)
 *   tick(price) = price / tick_size
 * Sentinels: lower_tick 0 = −∞, higher_tick POS_INF_TICK = +∞. So the binary
 * cash-or-nothing legs are special cases of a range:
 *   UP   (settles strictly above K) = (tick(K), +∞)
 *   DOWN (settles at/below K)        = (−∞, tick(K))
 *   RANGE (lo,hi]                    = (tick(lo), tick(hi))
 *
 * Minted strike ticks must align to the admission grid:
 *   admission_multiple = admission_tick_size / tick_size   (100 on BTC: $1 / $0.01)
 * (the ±∞ sentinels and a set reference_tick are exempt). Verified from source
 * strike_exposure.move / range_codec.move (branch predict-testnet-6-24).
 *
 * Pure + deterministic. All tick math is bigint to avoid f64 drift on 1e9 values.
 */

/** +∞ strike sentinel: (1 << 30) − 1. */
export const POS_INF_TICK = 1_073_741_823n;
/** −∞ strike sentinel. */
export const NEG_INF_TICK = 0n;

type IntLike = bigint | number | string;
const bi = (v: IntLike): bigint => (typeof v === 'bigint' ? v : BigInt(v));

/** Round-nearest division for positive bigints. */
function divRound(n: bigint, d: bigint): bigint {
  return (n + d / 2n) / d;
}

/** Strike (1e9-scaled) → tick index (round-nearest). */
export function strikeToTick(strikeScaled: IntLike, tickSize: IntLike): bigint {
  return divRound(bi(strikeScaled), bi(tickSize));
}

/** Tick index → strike (1e9-scaled). */
export function tickToStrike(tick: IntLike, tickSize: IntLike): bigint {
  return bi(tick) * bi(tickSize);
}

/** Admission grid step in ticks: admission_tick_size / tick_size. */
export function admissionMultiple(tickSize: IntLike, admissionTickSize: IntLike): bigint {
  return bi(admissionTickSize) / bi(tickSize);
}

/**
 * Snap a strike (1e9-scaled) to the nearest admission-aligned strike, so the
 * resulting tick satisfies `tick % admission_multiple == 0`.
 */
export function snapStrikeToAdmission(strikeScaled: IntLike, admissionTickSize: IntLike): bigint {
  const a = bi(admissionTickSize);
  return divRound(bi(strikeScaled), a) * a;
}

/** True if a strike tick is mintable (aligned to the admission grid, or a sentinel). */
export function isAdmissibleTick(tick: bigint, multiple: bigint): boolean {
  return tick === NEG_INF_TICK || tick === POS_INF_TICK || tick % multiple === 0n;
}

export interface TickRange {
  lowerTick: bigint;
  higherTick: bigint;
}

/**
 * Binary leg → (lower_tick, higher_tick). `strikeScaled` should already be
 * admission-snapped (use snapStrikeToAdmission). UP pays if settlement > strike;
 * DOWN pays if settlement ≤ strike.
 */
export function binaryTicks(strikeScaled: IntLike, isUp: boolean, tickSize: IntLike): TickRange {
  const strikeTick = strikeToTick(strikeScaled, tickSize);
  return isUp
    ? { lowerTick: strikeTick, higherTick: POS_INF_TICK }
    : { lowerTick: NEG_INF_TICK, higherTick: strikeTick };
}

/** Vertical range (lower, higher] → (lower_tick, higher_tick). */
export function rangeTicks(lowerScaled: IntLike, higherScaled: IntLike, tickSize: IntLike): TickRange {
  return {
    lowerTick: strikeToTick(lowerScaled, tickSize),
    higherTick: strikeToTick(higherScaled, tickSize),
  };
}

/** Leverage multiple (e.g. 3) → 1e9-scaled u64 the contract expects (3 → 3e9). */
export function leverageScaled(multiple: number): bigint {
  return BigInt(Math.round(multiple * 1e9));
}

/**
 * Apply slippage tolerance (basis points) to a base-unit cost as an upper cap —
 * the `max_cost` guard for the quantity mint path. e.g. 50 bps = +0.5%.
 */
export function maxCostWithSlippage(costBase: bigint, slippageBps: number): bigint {
  return (costBase * BigInt(10_000 + Math.round(slippageBps))) / 10_000n;
}

/**
 * Cap an entry probability (1e9-scaled fair unit price) with slippage for the
 * `max_probability` guard, clamped to the market's max entry probability.
 */
export function maxProbabilityWithSlippage(
  fairUnit1e9: bigint,
  slippageBps: number,
  marketMax1e9: bigint,
): bigint {
  const bumped = (fairUnit1e9 * BigInt(10_000 + Math.round(slippageBps))) / 10_000n;
  return bumped > marketMax1e9 ? marketMax1e9 : bumped;
}
