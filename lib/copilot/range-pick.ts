/**
 * lib/copilot/range-pick.ts — Kelly's RANGE pick for one market: a price band she
 * expects BTC to stay inside until the market settles.
 *
 * Autopilot's directional pick (respond.ts, bestValueReply) scans strikes either side
 * of spot, compares what the surface charges with how often BTC actually got there over
 * the same tenor lately, and takes the mispriced one; with nothing mispriced it falls
 * back to a plain safe bet. This is the same read for the third shape the venue offers.
 * Ranges are not a side show there: on 2026-09-04, 142 of the 330 most recent settled
 * bets across every trader were ranges, and the ones priced 70%+ won 80% of the time
 * (36W/9L), the same calibration as the directional bets. A calm market is a range's
 * friend and a trending one its enemy, and the tape is what tells the two apart.
 *
 * The band is centred on the surface's median in probability: P(above lower) = 0.5 + T/2
 * and P(above higher) = 0.5 - T/2, so P(inside) = T. That keeps it honest under skew.
 * Both edges then snap to the mintable grid. "How often BTC stayed inside" comes from
 * the same windows the strike analyzer uses: P(end > lower) - P(end > higher) over every
 * same-length window in the tape, which is exactly the band's hit rate.
 *
 * Pure: no React, no fetch, no signing. Unit-tested.
 */
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { rangeFair, strikeForUpProb, type SviFloat } from '@/lib/svi/svi';
import { analyzeStrike } from '@/lib/insights/strike-analysis';
import { CONVICTION_TARGET, type BetCandidate } from './respond';

export interface RangePick {
  marketId: string;
  expiry: number;
  /** Band edges ($), snapped to the admission grid. Pays if settlement lands in (lower, higher]. */
  lower: number;
  higher: number;
  /** The surface's chance settlement lands inside (0..1). */
  prob: number;
  /** How often BTC actually stayed inside a band this wide over the same tenor lately
   *  (0..1), or null with too little history to say. */
  empirical: number | null;
  /** Windows behind `empirical` (0 when null). */
  samples: number;
  /** Value edge: empirical minus the surface's price. 0 for a fairly priced band (a
   *  plain safe pick), the same convention as the directional pick, so a min-edge rule
   *  holds those back. */
  edge: number;
}

export interface RangePickInput {
  /** 1-minute closes, oldest first. Null (or short) means no history read. */
  closes: number[] | null;
  /** Live spot ($). Falls back to the market's forward. */
  spot: number | null;
  now: number;
  /** The band's win chance when nothing is mispriced. Defaults to the same "safe"
   *  target Kelly's directional pick falls back to, so the two shapes compare fairly. */
  target?: number;
}

/** Widths scanned for value, as the surface's own chance of staying inside. */
const SCAN_TARGETS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9] as const;

/** Below this a gap between history and price is noise, not value. The same bar the
 *  directional scan uses. */
export const MIN_VALUE_EDGE = 0.03;

/** The band the surface prices at `target` to stay inside, snapped, or null when it
 *  collapses to nothing on the grid (a tiny move priced on a coarse grid). */
export function bandForTarget(
  target: number,
  forward: number,
  svi: SviFloat,
  admissionTickSize: string | number | bigint,
): { lower: number; higher: number } | null {
  const t = Math.min(0.98, Math.max(0.02, target));
  const lower = toFloat(snapStrikeToAdmission(fromFloat(strikeForUpProb(0.5 + t / 2, forward, svi)), admissionTickSize));
  const higher = toFloat(snapStrikeToAdmission(fromFloat(strikeForUpProb(0.5 - t / 2, forward, svi)), admissionTickSize));
  if (!(higher > lower) || !(lower > 0)) return null;
  return { lower, higher };
}

/** How often, over the tape's same-length windows, BTC ended inside (lower, higher]. */
function empiricalInside(
  closes: number[],
  spot: number,
  lower: number,
  higher: number,
  minutesToExpiry: number,
): { prob: number; samples: number } | null {
  const above = (strike: number) => analyzeStrike({ closes, spot, strike, isUp: true, minutesToExpiry })?.empirical ?? null;
  const lo = above(lower);
  const hi = above(higher);
  if (!lo || !hi) return null;
  // Both rates come from the same windows, so their difference is the share of windows
  // that ended above the lower edge but not above the higher one: inside the band.
  return { prob: Math.max(0, lo.prob - hi.prob), samples: Math.min(lo.samples, hi.samples) };
}

/**
 * Kelly's range on one market, or null when she has none to offer: the surface cannot
 * price a band, or recent history says the priced bands are worse than they look.
 *
 * The scan mirrors the directional one. Every width is priced off the surface and
 * measured against the tape; a band that history has beaten by more than the noise bar
 * is a value pick, the biggest gap first. With nothing mispriced the band at `target`
 * is the plain pick, with edge 0. The one asymmetry is deliberate: a fairly priced
 * DIRECTIONAL fallback is always offered, but a range whose own history says it is
 * OVERPRICED is not. Ranges lose to trend, and the tape saying "BTC has been leaving
 * bands like this" is Kelly reading no good chance, which is the founder's bar for
 * placing one at all.
 */
export function pickRange(cand: BetCandidate, input: RangePickInput): RangePick | null {
  const { market, pricer } = cand;
  const forward = pricer.forward;
  if (!(forward > 0)) return null;
  const target = input.target ?? CONVICTION_TARGET.safe;
  const spot = input.spot ?? forward;
  const minutes = Math.max(1, Math.round((market.expiry - input.now) / 60_000));
  const closes = input.closes && input.closes.length >= 30 ? input.closes : null;

  type Scan = RangePick & { target: number };
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const t of [...SCAN_TARGETS, target]) {
    const band = bandForTarget(t, forward, pricer.svi, market.admission_tick_size);
    if (!band) continue;
    const key = `${band.lower}:${band.higher}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prob = rangeFair(band.lower, band.higher, forward, pricer.svi);
    // The tradeable middle only, as the directional scan keeps to: a band priced near
    // certain pays nothing, one near impossible is a lottery ticket.
    if (!(prob > 0.1) || !(prob < 0.9)) continue;
    const emp = closes ? empiricalInside(closes, spot, band.lower, band.higher, minutes) : null;
    scans.push({
      marketId: market.expiry_market_id,
      expiry: market.expiry,
      ...band,
      prob,
      empirical: emp?.prob ?? null,
      samples: emp?.samples ?? 0,
      edge: emp ? emp.prob - prob : 0,
      target: t,
    });
  }
  if (scans.length === 0) return null;

  const strip = (s: Scan): RangePick => ({
    marketId: s.marketId,
    expiry: s.expiry,
    lower: s.lower,
    higher: s.higher,
    prob: s.prob,
    empirical: s.empirical,
    samples: s.samples,
    edge: s.edge,
  });
  const value = scans.filter((s) => s.empirical != null && s.edge > MIN_VALUE_EDGE).sort((a, b) => b.edge - a.edge)[0];
  if (value) return strip(value);

  const plain = scans.reduce((best, s) => (Math.abs(s.target - target) < Math.abs(best.target - target) ? s : best));
  if (plain.empirical != null && plain.edge < -MIN_VALUE_EDGE) return null;
  return { ...strip(plain), edge: 0 };
}

/** The wider market's lean, as lib/insights/market-read reads it. Null with no live data. */
export type MarketLean = 'up' | 'down' | 'range' | null;

export type PickShape = 'binary' | 'range';

/**
 * Which shapes Kelly puts forward on one market, in the order to try them. Null edges
 * mean "no pick of that shape" (the trader's rules exclude it, or Kelly found none).
 *
 * A directional pick is always on the table when there is one: it is what Autopilot
 * has always placed. A range joins it when it is mispriced in the trader's favour, when
 * the wider market shows no clear direction (Kelly's own steer in chat: "no clear
 * direction, so a RANGE bet may fit better"), or when it is the only shape the rules
 * allow. Between the two, a real value gap wins; with neither mispriced the lean
 * decides. The second shape is the fallback for the same market when the first is
 * held back (a rule, the floor at the chain's price, a refused quote).
 */
export function shapeOrder(o: { binaryEdge: number | null; rangeEdge: number | null; lean: MarketLean }): PickShape[] {
  const hasBinary = o.binaryEdge != null;
  const hasRange = o.rangeEdge != null;
  const binaryValue = hasBinary && (o.binaryEdge as number) > MIN_VALUE_EDGE;
  const rangeValue = hasRange && (o.rangeEdge as number) > MIN_VALUE_EDGE;
  const rangeOffered = hasRange && (rangeValue || o.lean === 'range' || !hasBinary);
  if (!rangeOffered) return hasBinary ? ['binary'] : [];
  if (!hasBinary) return ['range'];
  const rangeFirst = rangeValue ? (o.rangeEdge as number) >= (o.binaryEdge as number) : !binaryValue;
  return rangeFirst ? ['range', 'binary'] : ['binary', 'range'];
}
