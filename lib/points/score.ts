/**
 * lib/points/score.ts — the trader Points score (phase 1, "Model A").
 *
 * A LIVE, DERIVED score: recomputed from the trader's own positions on every
 * load — no backend, no persistence, fully verifiable from server data. As they
 * keep trading the inputs grow, so the score grows with activity.
 *
 * Three components, by design:
 *   1. Liquidity  — DUSDC put to work minting positions (rewards participation).
 *   2. Performance — net profit, FLOORED AT ZERO: you always earn points, win or
 *                    lose; a loss simply contributes nothing here (never negative).
 *   3. Holding    — liquidity-weighted time in market (rewards conviction over
 *                    wash-mint/redeem churn).
 *
 * SCALING: position amounts arrive @6dec — de-scale with `fromQuote` here, never
 * downstream. Timestamps are ms epoch.
 */
import { fromQuote } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';

const DAY_MS = 86_400_000;

/**
 * Point rates — the entire tunable surface of the model, kept in one place and
 * surfaced in the UI so the score is explainable. Phase-1 defaults.
 */
export const POINTS_RATES = {
  /** Points per DUSDC of mint volume. */
  perDusdcVolume: 1,
  /** Points per DUSDC of net profit (losses floored at 0 → never negative). */
  perDusdcProfit: 2,
  /** Points per (DUSDC · day) held — liquidity-weighted conviction. */
  perDusdcDayHeld: 0.1,
} as const;

export interface PointsBreakdown {
  /** Points from liquidity used. */
  liquidity: number;
  /** Points from positive PnL (0 when net PnL ≤ 0). */
  performance: number;
  /** Points from holding duration. */
  holding: number;
  /** liquidity + performance + holding. */
  total: number;

  /* Raw inputs, for a transparent UI breakdown. */
  /** Total DUSDC paid to mint. */
  volume: number;
  /** Net realized + unrealized PnL in DUSDC (signed — the real figure). */
  netPnl: number;
  /** Liquidity-weighted average holding time, in days. */
  avgHoldDays: number;
}

/**
 * The three normalized inputs the score is a pure function of. Source-agnostic
 * so the Portfolio (from position summaries) and the Leaderboard (from event
 * streams) feed the SAME formula + rates and therefore agree.
 */
export interface PointsInput {
  /** Total DUSDC paid to mint. */
  volume: number;
  /** Net PnL in DUSDC (signed). Floored at 0 inside the formula. */
  netPnl: number;
  /** Σ (position cost in DUSDC · days held) — liquidity-weighted time in market. */
  dusdcDaysHeld: number;
}

/** The canonical scoring formula. Everything else adapts a data source to this. */
export function pointsFromInput({ volume, netPnl, dusdcDaysHeld }: PointsInput): PointsBreakdown {
  const liquidity = volume * POINTS_RATES.perDusdcVolume;
  const performance = Math.max(0, netPnl) * POINTS_RATES.perDusdcProfit;
  const holding = dusdcDaysHeld * POINTS_RATES.perDusdcDayHeld;
  return {
    liquidity,
    performance,
    holding,
    total: liquidity + performance + holding,
    volume,
    netPnl,
    avgHoldDays: volume > 0 ? dusdcDaysHeld / volume : 0,
  };
}

/** A position still counts as "held" while it has open quantity. */
function holdEndMs(p: PositionSummary, nowMs: number): number {
  return p.open_quantity > 0 ? nowMs : p.last_activity_at;
}

/**
 * Compute a trader's Points from their position summaries (the Portfolio
 * source — has authoritative realized + unrealized PnL). Pure: pass `nowMs` so
 * it's deterministic and testable. Empty input → an all-zero breakdown.
 */
export function computePoints(positions: PositionSummary[], nowMs: number): PointsBreakdown {
  let volume = 0;
  let netPnl = 0;
  let dusdcDaysHeld = 0; // Σ (cost · days held)

  for (const p of positions) {
    const cost = fromQuote(p.total_cost);
    volume += cost;
    netPnl += fromQuote(p.realized_pnl + p.unrealized_pnl);

    const days = Math.max(0, (holdEndMs(p, nowMs) - p.first_minted_at) / DAY_MS);
    dusdcDaysHeld += cost * days;
  }

  return pointsFromInput({ volume, netPnl, dusdcDaysHeld });
}
