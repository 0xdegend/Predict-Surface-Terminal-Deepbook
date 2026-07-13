/**
 * lib/risk/v2.ts — pure vault-risk derivations for the NEW deployment.
 *
 * Answers the LP's one question — "is the pool safe?" — from data v2 actually
 * exposes, and nothing it doesn't. The legacy /risk panel reprices real per-strike
 * open interest off the SVI surface under a spot shock; v2's open-interest endpoint
 * is AGGREGATE (a market's total max-payout-at-risk, not the strike/direction
 * breakdown), so a spot-shock reprice would be guessing the book. Instead we build
 * an honest SOLVENCY model: coverage of the pool against the gross payout it could
 * owe, and a conservative adverse-settlement stress derived from it.
 *
 * All amounts are DUSDC floats (already de-scaled by the caller via fromQuote).
 * Pure + deterministic so it unit-tests against fixed numbers.
 */
import type { V2Market, V2OpenInterest } from '@/lib/api/v2/types';

/** The vault's current standing, de-scaled to DUSDC floats. */
export interface VaultSnapshot {
  /** Full NAV: idle + capital deployed to open markets. */
  poolValue: number;
  /** PLP shares outstanding. */
  totalShares: number;
  /** Free, immediately-withdrawable DUSDC. */
  idle: number;
  /** Capital currently backing open markets (the vault's own mark). */
  deployed: number;
}

/** Per-market exposure row for the breakdown table. */
export interface MarketExposure {
  marketId: string;
  expiry: number;
  /** Open orders on the market. */
  orders: number;
  /** Gross max payout the pool could owe on this market's open bets (DUSDC). */
  maxPayout: number;
  /** Leveraged portion the pool fronted and gets back on a win (DUSDC). */
  floor: number;
  /** Share of the whole book's max payout (0..1) — for the bar width. */
  share: number;
}

export interface VaultRisk {
  snapshot: VaultSnapshot;
  sharePrice: number;
  /** Deployed / pool value (0..1) — how much of the pool is at work. */
  utilization: number;
  /** Idle / pool value (0..1) — share withdrawable without waiting on settlement. */
  headroom: number;
  /** Gross max payout across every open bet (DUSDC) — the worst-case outflow. */
  maxPayoutAtRisk: number;
  /**
   * poolValue / maxPayoutAtRisk. "If EVERY open bet won at once, the pool covers
   * it N×." Conservative: real payouts net the premiums already sitting in the
   * pool, so true coverage is higher — this is a floor. Infinity when nothing is
   * at risk.
   */
  coverage: number;
  /** Per-market exposure, largest first. */
  exposures: MarketExposure[];
}

const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);

/**
 * Fold the vault snapshot + per-market open interest into the risk view. `oiByMarket`
 * need only cover the active markets; a market missing from it contributes zero
 * (its OI hasn't loaded or it genuinely has no open bets).
 */
export function computeVaultRisk(
  snapshot: VaultSnapshot,
  markets: V2Market[],
  oiByMarket: Map<string, V2OpenInterest>,
  fromQuote: (base: string | number | bigint) => number,
): VaultRisk {
  const rows: Omit<MarketExposure, 'share'>[] = [];
  let maxPayoutAtRisk = 0;
  for (const m of markets) {
    const oi = oiByMarket.get(m.expiry_market_id);
    if (!oi || oi.open_order_count <= 0) continue;
    const maxPayout = fromQuote(oi.open_quantity);
    const floor = fromQuote(oi.open_floor_shares);
    maxPayoutAtRisk += maxPayout;
    rows.push({ marketId: m.expiry_market_id, expiry: m.expiry, orders: oi.open_order_count, maxPayout, floor });
  }

  const exposures: MarketExposure[] = rows
    .map((r) => ({ ...r, share: safeDiv(r.maxPayout, maxPayoutAtRisk) }))
    .sort((a, b) => b.maxPayout - a.maxPayout);

  return {
    snapshot,
    sharePrice: safeDiv(snapshot.poolValue, snapshot.totalShares),
    utilization: safeDiv(snapshot.deployed, snapshot.poolValue),
    headroom: safeDiv(snapshot.idle, snapshot.poolValue),
    maxPayoutAtRisk,
    coverage: maxPayoutAtRisk > 0 ? snapshot.poolValue / maxPayoutAtRisk : Infinity,
    exposures,
  };
}

/** One point on the adverse-settlement stress curve. */
export interface StressPoint {
  /** Fraction of the max payout-at-risk assumed to resolve against the pool (0..1). */
  adverse: number;
  /** DUSDC the pool would pay out under this stress. */
  outflow: number;
  /** Pool NAV after the outflow (DUSDC), floored at 0. */
  poolValueAfter: number;
  /** Share price after the outflow. */
  sharePriceAfter: number;
  /** Change in share price vs. now (fraction, signed). */
  sharePriceChangePct: number;
  /** True once the outflow exceeds the idle buffer — withdrawals would queue
   *  behind settlements rather than fill from cash on hand. */
  breachesIdle: boolean;
}

/**
 * Adverse-settlement stress: assume a fraction `adverse` of the gross max payout
 * resolves as wins the pool must pay, funded from NAV. Deliberately conservative —
 * it ignores the premiums those bets already paid into the pool (which would offset
 * the outflow), so the modelled hit OVERSTATES the loss and the true pool is more
 * resilient than the curve shows. `adverse = 1` (every open bet wins) is the pool's
 * absolute worst case, and the point where `poolValueAfter` hits 0 is exactly the
 * coverage ratio.
 */
export function stressPoint(risk: VaultRisk, adverse: number): StressPoint {
  const a = Math.max(0, Math.min(1, adverse));
  const outflow = a * risk.maxPayoutAtRisk;
  const poolValueAfter = Math.max(0, risk.snapshot.poolValue - outflow);
  const sharePriceAfter = safeDiv(poolValueAfter, risk.snapshot.totalShares);
  const sharePriceChangePct = risk.sharePrice > 0 ? sharePriceAfter / risk.sharePrice - 1 : 0;
  return {
    adverse: a,
    outflow,
    poolValueAfter,
    sharePriceAfter,
    sharePriceChangePct,
    breachesIdle: outflow > risk.snapshot.idle,
  };
}

/** Sample the stress curve across `steps` evenly-spaced adverse fractions (0..1). */
export function stressCurve(risk: VaultRisk, steps = 24): StressPoint[] {
  const out: StressPoint[] = [];
  for (let i = 0; i <= steps; i++) out.push(stressPoint(risk, i / steps));
  return out;
}

/** One share-price sample, from a keeper flush. */
export interface SharePricePoint {
  timestamp_ms: number;
  share_price: number;
  vault_value: number; // DUSDC
  total_shares: number; // PLP
}

/**
 * Share-price history from flush events. Each flush marks the whole pool, so
 * pool_value/total_supply at each flush IS the share price then — v2's stand-in for
 * legacy's `/vault/performance` series. Oldest-first (the chart draws left→right);
 * flushes with no shares (pre-seed) are dropped.
 */
export function sharePriceSeries(
  flushes: { checkpoint_timestamp_ms: number; pool_value: string; total_supply: string }[],
  fromQuote: (base: string | number | bigint) => number,
): SharePricePoint[] {
  return flushes
    .filter((f) => Number(f.total_supply) > 0)
    .map((f) => ({
      timestamp_ms: f.checkpoint_timestamp_ms,
      share_price: Number(f.pool_value) / Number(f.total_supply),
      vault_value: fromQuote(f.pool_value),
      total_shares: fromQuote(f.total_supply),
    }))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
}
