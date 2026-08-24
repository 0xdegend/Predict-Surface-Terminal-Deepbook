/**
 * lib/insights/edge-scan.ts — the Edge Scanner's brain.
 *
 * Sweeps EVERY open expiry × a dense column of mintable strikes × both sides and
 * ranks where the surface is CHEAP versus how often that move has actually landed
 * on the recent tape. It is the cross-expiry generalization of the single-expiry
 * probability ladder + reality check: the ladder lets you eyeball one market, this
 * screens all of them at once and floats the standout edges to the top.
 *
 * The "edge" is `empirical − implied` in probability points, using the SAME two
 * numbers the ladder shows (the surface's `upFair`/`dnFair` and the empirical
 * terminal hit-rate). Positive = the event happened MORE often lately than the
 * surface charges → a value buy. Because up/down at a strike are mirror images,
 * only the value side of each strike is emitted (its opposite is the same edge
 * with the sign flipped, so listing both is noise).
 *
 * FEES DECIDE ADMISSION, not the gross edge. Beating the surface by 2 points is
 * worth nothing when it costs ~2.2 points to trade: the fee is charged on NOTIONAL,
 * so it eats a roughly flat 2.0-2.4 probability points at every strike on the live
 * config (see lib/markets/v2-fees). This screener's old default admitted anything
 * over +2 gross, which put break-even and losing trades at the TOP of a board headed
 * "where the surface is cheap". Admission is now on the NET edge, so a row on the
 * board is a row that makes money if the base rate holds.
 *
 * Honest limits (inherited from strike-analysis): the empirical rate is a base
 * rate over a recent ~33h regime window from overlapping samples — NOT a forecast.
 * A positive edge means "recently underpriced vs realized", which is a real (if
 * noisy) vol read, never a guarantee. Surfaced with the sample count so it can be
 * weighed, and gated to strikes with a reliable sample + a sane implied band.
 *
 * Pure + side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */
import { buildLadder } from '@/lib/markets/v2-ladder';
import { netEdgePts, netEvPct, netPayoutMultiple, NO_FEES, type FeeRates } from '@/lib/markets/v2-fees';
import { analyzeStrikeForMarket } from './engine';
import type { SviFloat } from '@/lib/svi/svi';

export interface EdgeCandidate {
  marketId: string;
  expiryMs: number;
  /** Admission-snapped strike ($), guaranteed mintable (one-click Bet). */
  strike: number;
  /** The value side — the direction whose recent hit-rate beats its price. */
  isUp: boolean;
  /** The surface's fair probability for the value side (0..1). */
  implied: number;
  /** Recent terminal hit-rate for the value side (0..1). */
  empirical: number;
  /** How many recent windows the empirical rate is measured over. */
  samples: number;
  /** How many NON-OVERLAPPING windows back it — the honest sample size. */
  independentWindows: number;
  /** empirical − implied, in probability POINTS, BEFORE fees (> 0 = beats the surface). */
  edgePts: number;
  /** The same edge after fees — the number that decides whether this is a trade. */
  netEdgePts: number;
  /** Expected value per $1 committed, AFTER fees, as a %. */
  evPct: number;
  /** Gross payout multiple at the fair price (1 / implied). */
  payout: number;
  /** Payout after fees — what the trader actually collects. */
  netPayout: number;
  /** Signed move from the forward to this strike, in percent. */
  movePct: number;
}

export interface EdgeScanMarket {
  marketId: string;
  expiryMs: number;
  admissionTickSize: string | bigint;
  pricer: { forward: number; svi: SviFloat };
  /** Fees on THIS market (base_fee is per-market). Omitted → no fee is charged. */
  feeRates?: FeeRates;
}

export interface EdgeScanInput {
  markets: EdgeScanMarket[];
  /** Recent 1-minute closes (oldest → newest) — the empirical base rate. */
  closes: number[] | null | undefined;
  /** Reference clock (ms) — pass the price feed's timestamp, not Date.now(). */
  now: number;
  /**
   * Only emit candidates whose NET (after-fee) edge clears this many points.
   * Default 1 — a real margin over break-even, not break-even itself. Was a gross
   * threshold of 2, which on the live config admitted exactly the trades that lose.
   */
  minNetEdgePts?: number;
  /** Chance-above targets the strike column is built from (density). */
  targets?: number[];
  /** Cap on the returned pool the UI then sorts + trims (default 40). */
  limit?: number;
}

/** A denser strike column than the ladder's default, still safely inside the
 *  quotable band so every rung stays mintable — more granularity catches edges in
 *  the wings (where the smile and the realized tails most disagree). */
const SCAN_TARGETS = [0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44, 0.38, 0.32, 0.26, 0.2];

/** Skip the extreme wings — a winning side priced under ~4% (or over ~96%) has too
 *  few winning samples to trust and an unstable EV denominator. */
const MIN_IMPLIED = 0.04;
const MAX_IMPLIED = 0.96;

export function scanEdges({
  markets,
  closes,
  now,
  minNetEdgePts = 1,
  targets = SCAN_TARGETS,
  limit = 40,
}: EdgeScanInput): EdgeCandidate[] {
  if (!closes || closes.length < 3) return [];

  const out: EdgeCandidate[] = [];
  for (const m of markets) {
    if (!(m.pricer.forward > 0) || m.expiryMs <= now) continue;
    const rungs = buildLadder(m.pricer, m.admissionTickSize, targets);
    for (const r of rungs) {
      const up = analyzeStrikeForMarket({ closes, pricer: m.pricer, strike: r.strike, isUp: true, expiryMs: m.expiryMs, now });
      const dn = analyzeStrikeForMarket({ closes, pricer: m.pricer, strike: r.strike, isUp: false, expiryMs: m.expiryMs, now });
      if (!up?.empirical || up.implied == null || !dn?.empirical || dn.implied == null) continue;

      // Mirror sides: whichever direction's recent hit-rate beats its price is the
      // value buy; the other is the same edge negated, so only this one is emitted.
      const isUp = up.empirical.prob - up.implied >= 0;
      const a = isUp ? up : dn;
      const implied = a.implied!;
      const empirical = a.empirical!.prob;
      if (implied < MIN_IMPLIED || implied > MAX_IMPLIED) continue;

      const rates = m.feeRates ?? NO_FEES;
      const net = netEdgePts(empirical, implied, rates);
      if (net < minNetEdgePts) continue;

      out.push({
        marketId: m.marketId,
        expiryMs: m.expiryMs,
        strike: r.strike,
        isUp,
        implied,
        empirical,
        samples: a.empirical!.samples,
        independentWindows: a.empirical!.independentWindows,
        edgePts: (empirical - implied) * 100,
        netEdgePts: net,
        evPct: netEvPct(empirical, implied, rates),
        payout: 1 / implied,
        netPayout: netPayoutMultiple(implied, rates),
        movePct: a.requiredMovePct,
      });
    }
  }

  // Ranked by the NET edge, so the top of the board is the best TRADE rather than
  // the biggest disagreement with the surface.
  out.sort((x, y) => y.netEdgePts - x.netEdgePts);
  return out.slice(0, limit);
}
