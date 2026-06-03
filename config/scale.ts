/**
 * config/scale.ts — the ONE place numeric scaling lives.
 *
 * Two independent scales in this protocol, never to be mixed:
 *
 *  1. FLOAT_SCALING = 1e9  → all protocol prices, strikes, forwards, spot, and
 *     SVI params (a, b, rho, m, sigma) are u64/i64 integers scaled by 1e9.
 *     Use toFloat / fromFloat.
 *
 *  2. Quote decimals = 6   → DUSDC amounts (mint cost, payouts, balances) are
 *     u64 integers in base units (1 DUSDC = 1_000_000).
 *     Use toQuote / fromQuote.
 *
 * Rule of thumb:
 *   - Anything that is a *price of the underlying* or an *SVI param* → FLOAT_SCALING.
 *   - Anything that is an *amount of DUSDC* → quote decimals.
 *
 * On-chain values are u64/i64. We accept `number | bigint | string` on the way in
 * (server JSON gives numbers, chain reads give bigints/strings) and always return
 * plain `number` floats for display math, or `bigint` for amounts headed back to chain.
 */

import { predictConfig } from './predict';

export const FLOAT_SCALING = 1_000_000_000; // 1e9
export const FLOAT_SCALING_BI = 1_000_000_000n;

type IntLike = number | bigint | string;

function toNumber(v: IntLike): number {
  return typeof v === 'number' ? v : Number(v);
}

function toBigInt(v: IntLike): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`toBigInt: non-integer number ${v}`);
    return BigInt(v);
  }
  return BigInt(v);
}

/* ------------------------------------------------------------------ *
 * FLOAT_SCALING (1e9) — prices, strikes, forwards, SVI params
 * ------------------------------------------------------------------ */

/** 1e9-scaled integer → float. e.g. 66938960474811 → 66938.960474811 */
export function toFloat(scaled: IntLike): number {
  return toNumber(scaled) / FLOAT_SCALING;
}

/** float → 1e9-scaled bigint (for values headed to chain). Rounds to nearest. */
export function fromFloat(value: number): bigint {
  return BigInt(Math.round(value * FLOAT_SCALING));
}

/**
 * Parse the server's signed-magnitude SVI encoding into a float.
 * The server returns e.g. { rho: 940001720, rho_negative: true } → -0.94000172.
 */
export function signedToFloat(magnitude: IntLike, negative: boolean): number {
  const f = toFloat(magnitude);
  return negative ? -f : f;
}

/**
 * Parse an on-chain i64::I64 event field. The Move I64 is { bits: u64, ... } in
 * raw events; deserialized BCS commonly surfaces as { negative: bool, magnitude }
 * or a tagged value. This helper is intentionally tolerant — see lib/api when the
 * exact raw-event shape is confirmed in Phase 3.
 */
export function i64ToFloat(field: { magnitude: IntLike; negative: boolean }): number {
  return signedToFloat(field.magnitude, field.negative);
}

/* ------------------------------------------------------------------ *
 * Quote scale (DUSDC, 6 decimals) — amounts
 * ------------------------------------------------------------------ */

const QUOTE_UNIT_BI = 10n ** BigInt(predictConfig.quote.decimals);
const QUOTE_UNIT = Number(QUOTE_UNIT_BI);

/** base units (u64) → human DUSDC float. e.g. 1_000_000 → 1.0 */
export function fromQuote(base: IntLike): number {
  return toNumber(base) / QUOTE_UNIT;
}

/** human DUSDC float → base units bigint (for coin amounts headed to chain). */
export function toQuote(value: number): bigint {
  return BigInt(Math.round(value * QUOTE_UNIT));
}

/** Precise base-unit → float without f64 rounding for large balances (display only). */
export function fromQuotePrecise(base: IntLike): number {
  const b = toBigInt(base);
  const whole = b / QUOTE_UNIT_BI;
  const frac = b % QUOTE_UNIT_BI;
  return Number(whole) + Number(frac) / QUOTE_UNIT;
}
