/**
 * lib/insights/consensus.ts — four independent, horizon-matched reads of the SAME
 * bet, on one scale.
 *
 *   1. Our surface       — the SVI implied probability (upFair / dnFair).
 *   2. What traders paid — the premium-weighted entry probability on OUR book at this
 *                          exact strike and side. Not a model: the price people took.
 *   3. Recent-vol model  — a normal-model probability fed by REALIZED vol: "the odds
 *                          if BTC keeps moving like it has lately".
 *   4. Happened lately   — the raw empirical hit-rate over the recent 1-minute tape.
 *
 * They share the strike and the horizon, so they're genuinely comparable — unlike a
 * longer-dated crowd market, which is why Polymarket is deliberately NOT a source (its
 * BTC markets are weekly/monthly, not our minutes-to-hours). That exclusion used to
 * leave the panel with no crowd read at all, and it did not have to: our own book IS a
 * crowd, quoted at our own horizon by construction. Source 2 closes that hole, and it
 * is the only one of the four that is not derived from the same price tape as the
 * others — which is exactly what makes a consensus worth taking.
 *
 * When the reads cluster, the bet is priced about right; when they split, the gap is
 * the read.
 *
 * PURE + tested. Sources are omitted, never faked: a strike nobody has traded simply
 * has no crowd read.
 */
import { normalCdf } from '@/lib/svi/normal';

export interface ConsensusSource {
  key: 'surface' | 'crowd' | 'recentVol' | 'history';
  /** Pro label. */
  label: string;
  /** Plain label. */
  plainLabel: string;
  /** Directional probability (matches `isUp`), 0..1. */
  prob: number;
}

export interface Consensus {
  sources: ConsensusSource[];
  low: number;
  high: number;
  /** Median of the reads. */
  mid: number;
  /** (high − low) in probability points. */
  spreadPts: number;
  agreement: 'tight' | 'split';
  /** Plain-language takeaway. */
  synthesis: string;
}

/** The recent-volatility model probability for the bet's direction, from the signed
 *  z-score of the required move (driftless normal, matching the surface's convention).
 *  P(settle above) = Φ(−z); below = Φ(z). */
export function recentVolProb(sigmaMove: number, isUp: boolean): number {
  return isUp ? normalCdf(-sigmaMove) : normalCdf(sigmaMove);
}

const TIGHT_PTS = 8;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function buildConsensus(input: {
  isUp: boolean;
  surfaceProb: number | null;
  sigmaMove: number | null;
  empiricalProb: number | null;
  /** Premium-weighted entry probability paid on our own book at this strike + side. */
  paidProb?: number | null;
}): Consensus | null {
  const { isUp, surfaceProb, sigmaMove, empiricalProb, paidProb } = input;

  const sources: ConsensusSource[] = [];
  if (surfaceProb != null && Number.isFinite(surfaceProb)) {
    sources.push({ key: 'surface', label: 'SVI implied', plainLabel: 'Our surface', prob: clamp01(surfaceProb) });
  }
  // Second, so it sits next to the other PRICE read. The screen renders sources[0] as
  // its single Plain bar, so the surface has to keep index 0.
  if (paidProb != null && Number.isFinite(paidProb)) {
    sources.push({ key: 'crowd', label: 'Paid on our book', plainLabel: 'What traders paid', prob: clamp01(paidProb) });
  }
  if (sigmaMove != null && Number.isFinite(sigmaMove)) {
    sources.push({ key: 'recentVol', label: 'Realized-vol model', plainLabel: 'If it moves like lately', prob: clamp01(recentVolProb(sigmaMove, isUp)) });
  }
  if (empiricalProb != null && Number.isFinite(empiricalProb)) {
    sources.push({ key: 'history', label: 'Empirical hit-rate', plainLabel: 'How often it happened', prob: clamp01(empiricalProb) });
  }
  if (sources.length < 2) return null;

  const probs = sources.map((s) => s.prob);
  const low = Math.min(...probs);
  const high = Math.max(...probs);
  const mid = probs.slice().sort((a, b) => a - b)[Math.floor(probs.length / 2)];
  const spreadPts = (high - low) * 100;
  const agreement: Consensus['agreement'] = spreadPts <= TIGHT_PTS ? 'tight' : 'split';

  return { sources, low, high, mid, spreadPts, agreement, synthesis: synthesize(sources, mid, spreadPts, agreement) };
}

function synthesize(sources: ConsensusSource[], mid: number, spreadPts: number, agreement: Consensus['agreement']): string {
  const pct = Math.round(mid * 100);
  const odds = oddsPhrase(mid);
  if (agreement === 'tight') {
    return `All ${sources.length} reads land within ${Math.round(spreadPts)} points of each other — about a ${pct}% chance (${odds}). A well-priced bet.`;
  }
  const hi = sources.reduce((a, b) => (a.prob >= b.prob ? a : b));
  const lo = sources.reduce((a, b) => (a.prob <= b.prob ? a : b));
  return `The reads split by ${Math.round(spreadPts)} points — "${lo.plainLabel}" is coolest, "${hi.plainLabel}" warmest, around a ${pct}% chance (${odds}). That gap is the opportunity.`;
}

function oddsPhrase(p: number): string {
  if (p < 0.45) return `~1 in ${Math.max(2, Math.round(1 / p))}`;
  if (p > 0.55) return 'better than even';
  return 'roughly a coin flip';
}
