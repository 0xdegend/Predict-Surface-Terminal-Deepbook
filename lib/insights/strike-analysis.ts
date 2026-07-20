/**
 * lib/insights/strike-analysis.ts — what a picked strike actually asks of the
 * market, measured against what the market has recently done.
 *
 * The surface gives the FAIR (implied) probability of a strike from the SVI vol
 * the protocol prices against. This module gives the independent, backward-
 * looking counterpart: over the last ~33h of 1-minute closes, how often did BTC
 * actually travel far enough, in the same amount of time, to settle the trade?
 * Two answers to the same question from two unrelated sources — where they
 * disagree is exactly the read a trader is looking for.
 *
 * Pure and side-effect free (CLAUDE.md §6.5): no fetching, no React, unit-tested.
 *
 * Honest about its limits. This is a base rate over a recent sample, NOT a
 * forecast — a 33h window carries whatever regime it happened to contain, and
 * overlapping windows mean the samples aren't independent. It is reported as
 * "how often this happened lately", never as "the odds".
 */

/** Minutes of 1-minute bars per year — annualizes a per-bar vol. */
const BARS_PER_YEAR = 525_600;

/** Below this the empirical rate is noise, so we return none rather than a number. */
const MIN_SAMPLES = 120;

export interface StrikeAnalysis {
  /** Signed move from spot to strike, in percent (+ = strike is above spot). */
  requiredMovePct: number;
  /** …and in dollars. */
  requiredMoveUsd: number;
  /** How far that move is in standard deviations, given the time left. */
  sigmaMove: number;
  /** Annualized realized vol from the 1-minute tape, in percent. */
  realizedVolPct: number;
  /** Share of recent same-length windows that finished on the winning side. */
  empirical: { prob: number; samples: number; horizonBars: number } | null;
  /** The surface's fair probability for this strike, 0-1 (passed in). */
  implied: number | null;
  /** implied − empirical, in probability POINTS. + = surface asks more than
   *  history did. null when either side is missing. */
  edgePts: number | null;
}

export interface StrikeAnalysisInput {
  /** 1-minute closes, oldest → newest. */
  closes: number[];
  spot: number;
  strike: number;
  /** true = the bet wins when settlement lands ABOVE the strike. */
  isUp: boolean;
  /** Time left until settlement, in minutes (may be fractional). */
  minutesToExpiry: number;
  /** The surface's fair probability for this strike/direction, 0-1. */
  impliedProb?: number | null;
}

/** Annualized vol from log returns of a close series. */
export function realizedVol(closes: number[]): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, c) => a + c, 0) / rets.length;
  const variance = rets.reduce((a, c) => a + (c - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(BARS_PER_YEAR);
}

/**
 * How often a move of at least `requiredRet` (signed log-free simple return)
 * happened over `horizonBars` bars, in the direction the bet needs.
 *
 * TERMINAL, not touch: these binaries settle on the price AT expiry, so a window
 * that spikes through the strike and comes back is a LOSS. Comparing only
 * start→end is what makes this match the payoff.
 *
 * Windows overlap (every bar starts one), which maximizes sample count at the
 * cost of independence — fine for a base rate, and why `samples` is surfaced so
 * the number can be weighed.
 */
export function empiricalHitRate(
  closes: number[],
  horizonBars: number,
  requiredRet: number,
  isUp: boolean,
): { prob: number; samples: number } | null {
  const h = Math.max(1, Math.round(horizonBars));
  const n = closes.length;
  if (n - h < MIN_SAMPLES) return null;

  let hits = 0;
  let samples = 0;
  for (let i = 0; i + h < n; i++) {
    const from = closes[i];
    if (from <= 0) continue;
    const ret = closes[i + h] / from - 1;
    // Strictly greater: settling exactly on the strike is not "above" it.
    if (isUp ? ret > requiredRet : ret < requiredRet) hits++;
    samples++;
  }
  if (samples < MIN_SAMPLES) return null;
  return { prob: hits / samples, samples };
}

export function analyzeStrike({
  closes,
  spot,
  strike,
  isUp,
  minutesToExpiry,
  impliedProb,
}: StrikeAnalysisInput): StrikeAnalysis | null {
  if (!(spot > 0) || !(strike > 0) || closes.length < 3) return null;

  const requiredRet = strike / spot - 1;
  const vol = realizedVol(closes);

  // σ of the move over the time remaining, from the same annualized vol.
  const tYears = Math.max(minutesToExpiry, 0) / BARS_PER_YEAR;
  const sigmaOverT = vol * Math.sqrt(tYears);
  const sigmaMove = sigmaOverT > 0 ? requiredRet / sigmaOverT : 0;

  const empirical = empiricalHitRate(closes, minutesToExpiry, requiredRet, isUp);

  const implied = impliedProb != null && Number.isFinite(impliedProb) ? impliedProb : null;
  const edgePts = implied != null && empirical ? (implied - empirical.prob) * 100 : null;

  return {
    requiredMovePct: requiredRet * 100,
    requiredMoveUsd: strike - spot,
    sigmaMove,
    realizedVolPct: vol * 100,
    empirical: empirical ? { ...empirical, horizonBars: Math.max(1, Math.round(minutesToExpiry)) } : null,
    implied,
    edgePts,
  };
}

/**
 * The one-line read, in plain words — no "edge", no "vol", no Greek. Positive
 * `edgePts` means the surface is charging more than recent history justifies.
 */
export function strikeVerdict(a: StrikeAnalysis): { tone: 'rich' | 'cheap' | 'fair' | 'none'; text: string } {
  if (a.edgePts == null || !a.empirical) {
    return { tone: 'none', text: 'Not enough recent history to compare this one.' };
  }
  const pts = Math.abs(a.edgePts).toFixed(0);
  if (a.edgePts > 3) {
    return { tone: 'rich', text: `Costs about ${pts} points more than moves like this have paid off lately.` };
  }
  if (a.edgePts < -3) {
    return { tone: 'cheap', text: `Costs about ${pts} points less than moves like this have paid off lately.` };
  }
  return { tone: 'fair', text: 'Priced in line with how often this has happened lately.' };
}
