/**
 * lib/insights/house-book.ts — the other side of every trade, in plain words.
 *
 * WHY THIS IS THE PAGE'S STRONGEST CLAIM. On Deribit, on CME, on any venue with a
 * market maker, the counterparty's inventory is private. Whole businesses exist to
 * *estimate* dealer positioning and sell the guess. DeepBook Predict has no such
 * secret: the counterparty to every binary minted here is the PLP vault, and the
 * vault's balance sheet is a public object on chain. Its size, how much of it is
 * committed, and the worst case it is standing behind are all readable by anyone.
 *
 * So this is not "our vault stats" bolted onto an options page. It is the answer to a
 * question a trader cannot ask anywhere else: *who is on the other side of this, and
 * can they pay?* The risk page already computed every figure (lib/risk/v2.ts); it had
 * simply never been framed from the trader's side of the table.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO. It does not present coverage as a safety
 * promise — `coverage` is a conservative floor by construction (see `computeVaultRisk`,
 * which ignores the premiums already paid in), and the wording says "covers it N times
 * over" rather than "your payout is guaranteed". And it does not read a thin book as a
 * signal: with nothing at risk anywhere, `here` is null and the summary says the market
 * is quiet rather than inventing a lean.
 *
 * Pure and side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */
import { compact } from '@/lib/format';
import type { VaultRisk } from '@/lib/risk/v2';

/** How solid the backing looks. Drives tone, never a recommendation. */
export type HouseStanding = 'strong' | 'normal' | 'stretched';

/** Coverage at or above this reads as comfortable. */
export const STRONG_COVERAGE = 5;
/** Below this the pool is standing behind a lot relative to its size. */
export const STRETCHED_COVERAGE = 2;
/** Utilization at or above this is "most of the pool is committed". */
export const STRETCHED_UTILIZATION = 0.75;

/** This market's slice of the whole book. */
export interface HouseSlice {
  /** Max payout the pool could owe on THIS market's open bets (DUSDC). */
  atRiskUsd: number;
  /** Share of the whole book's max payout (0..1). */
  share: number;
  /** Open orders on this market. */
  orders: number;
}

export interface HouseBook {
  /** Full pool NAV (DUSDC) — idle plus capital deployed to open markets. */
  poolUsd: number;
  /** Deployed / NAV (0..1) — how much of the pool is at work right now. */
  atWork: number;
  /** Free, immediately-withdrawable DUSDC. */
  idleUsd: number;
  /** Gross max payout across every open bet on every market (DUSDC). */
  atRiskUsd: number;
  /**
   * poolUsd / atRiskUsd. "If every open bet won at once, the pool covers it N times."
   * Infinity when nothing is at risk. A conservative floor: real settlement nets the
   * premiums already sitting in the pool, so true coverage is higher than this.
   */
  coverage: number;
  /** The selected market's slice, or null when it has no open interest. */
  here: HouseSlice | null;
  standing: HouseStanding;
  /** One plain sentence for the panel's footer. */
  summary: string;
}

/** Coverage and utilization together, because either one alone can mislead: a pool
 *  with nothing deployed has infinite coverage and tells you nothing, and a busy pool
 *  with deep backing is not stretched. */
export function houseStanding(coverage: number, atWork: number): HouseStanding {
  if (coverage >= STRONG_COVERAGE && atWork < STRETCHED_UTILIZATION) return 'strong';
  if (coverage < STRETCHED_COVERAGE || atWork >= STRETCHED_UTILIZATION) return 'stretched';
  return 'normal';
}

/**
 * Fold the vault risk view into the options page's read for ONE market. Returns null
 * without a pool to describe, so the panel is absent rather than showing zeroes.
 */
export function buildHouseBook(risk: VaultRisk | null | undefined, marketId: string | null): HouseBook | null {
  if (!risk || !(risk.snapshot.poolValue > 0)) return null;

  const exposure = marketId ? risk.exposures.find((e) => e.marketId === marketId) : undefined;
  const here: HouseSlice | null = exposure
    ? { atRiskUsd: exposure.maxPayout, share: exposure.share, orders: exposure.orders }
    : null;

  const standing = houseStanding(risk.coverage, risk.utilization);

  return {
    poolUsd: risk.snapshot.poolValue,
    atWork: risk.utilization,
    idleUsd: risk.snapshot.idle,
    atRiskUsd: risk.maxPayoutAtRisk,
    coverage: risk.coverage,
    here,
    standing,
    summary: summarize(risk, here, standing),
  };
}

function summarize(risk: VaultRisk, here: HouseSlice | null, standing: HouseStanding): string {
  const pool = `$${compact(risk.snapshot.poolValue)}`;

  // Nothing open anywhere: say so rather than dressing up an idle pool as depth.
  if (!(risk.maxPayoutAtRisk > 0)) {
    return `${pool} in the pool and nothing at risk yet. The house is flat.`;
  }

  const cover =
    risk.coverage >= 100 ? 'many times over' : `${risk.coverage < 10 ? risk.coverage.toFixed(1) : Math.round(risk.coverage)} times over`;

  const backing =
    standing === 'stretched'
      ? `${pool} in the pool against $${compact(risk.maxPayoutAtRisk)} of open bets, so the house is carrying a lot right now.`
      : `${pool} in the pool, enough to cover every open bet ${cover} if they all won at once.`;

  if (!here || !(here.atRiskUsd > 0)) return `${backing} Nothing open on this expiry yet.`;

  const slice =
    here.share >= 0.5
      ? `Most of that sits on this expiry`
      : here.share >= 0.15
        ? `A good slice of that sits on this expiry`
        : `A small part of that sits on this expiry`;

  return `${backing} ${slice}: $${compact(here.atRiskUsd)} across ${here.orders} open ${here.orders === 1 ? 'bet' : 'bets'}.`;
}
