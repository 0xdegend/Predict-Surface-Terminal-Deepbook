/**
 * lib/insights/surface-headline.ts — what the surface says, before you pick anything.
 *
 * The page opened on four regime pills, a 3-D surface and a card whose headline came
 * from off-chain context (Clawby). Everything that actually reads OUR data stayed
 * silent until a strike was chosen, which is backwards for a page whose whole claim is
 * that it renders the best options data in crypto: a data page has to make a statement
 * before it is touched.
 *
 * So this builds one sentence from the surface alone. No strike, no Clawby, no candles,
 * no crowd. Just the expected move, which side the smile charges more for, and how the
 * term structure is shaped. Every input is something the protocol published.
 *
 * WHAT IT REFUSES TO DO. It never predicts direction. A risk reversal says which side
 * is DEAR, not which way price is going, and those get conflated constantly ("puts are
 * bid, so it's going down"). The wording here always attributes the lean to pricing:
 * "the market is paying up for downside", never "downside is likely". The one number
 * that IS directional, `upChance`, is deliberately not in the sentence, because at the
 * money it is always near a coin flip and reads as a forecast when it is not.
 *
 * Pure and side-effect free (CLAUDE.md §6.5): no fetch, no React, unit-tested.
 */
import { num } from '@/lib/format';
import type { ExpectedMove } from './expected-move';
import type { SurfaceShape } from './surface-shape';
import type { IvBand } from './iv-history';

/** Below this the two sides are priced close enough to call even (vol points). */
export const RR_FLAT_PTS = 1.5;
/** Above this the skew is worth calling out as pronounced (vol points). */
export const RR_STRONG_PTS = 4;
/** Term-structure slope below this reads as flat (vol points across the curve). */
export const TERM_FLAT_PTS = 2;

export type HeadlineTone = 'up' | 'down' | 'neutral';

export interface SurfaceHeadline {
  /** The lead sentence. Plain language, no jargon, safe for a first-time reader. */
  text: string;
  /** Supporting observations for anyone who wants the numbers. Already plain. */
  detail: string[];
  tone: HeadlineTone;
}

export interface SurfaceHeadlineInput {
  /** Ticker, e.g. "BTC". */
  asset: string;
  /** The selected expiry's expected move. Required: it carries the sentence. */
  em: ExpectedMove | null;
  /** Human horizon, e.g. "1 hour" / "4 min". */
  horizon: string | null;
  /** The selected expiry's smile shape, for the dear-side clause. */
  shape: SurfaceShape | null;
  /** At-the-money implied vol for the selected expiry (annualized fraction). */
  atmIv: number | null;
  /** Where that vol sits against this market's own history, when known. */
  ivBand: IvBand | null;
  /** ATM IV at the shortest and longest live expiry, for the term-structure line. */
  term: { nearIv: number; farIv: number } | null;
  /** Forward premium over spot, in percent. */
  basisPct: number | null;
}

/**
 * One sentence about the market, from the surface. Null without an expected move,
 * because that is the clause the whole sentence is built around and a headline with
 * no number in it is filler.
 */
export function buildSurfaceHeadline(input: SurfaceHeadlineInput): SurfaceHeadline | null {
  const { asset, em, horizon, shape, atmIv, ivBand, term, basisPct } = input;
  if (!em || !(em.forward > 0) || !(em.sigma > 0)) return null;

  const move = em.sigma * em.forward;
  const when = horizon ? ` in the next ${horizon}` : '';
  const lead = `${asset} is priced to move about $${num(move, 0)} either way${when}.`;

  const rr = shape?.rr25Pts ?? null;
  const dear = dearSide(rr);
  const tone: HeadlineTone = dear === 'downside' ? 'down' : dear === 'upside' ? 'up' : 'neutral';

  const strong = rr != null && Math.abs(rr) >= RR_STRONG_PTS;
  const clause =
    dear === null
      ? 'Both sides are priced about the same.'
      : `The market is ${strong ? 'paying well up' : 'paying up'} for ${dear} protection.`;

  return { text: `${lead} ${clause}`, detail: buildDetail({ atmIv, ivBand, term, basisPct, em }), tone };
}

/** Which side of the smile costs more. Null inside the flat band. */
export function dearSide(rr25Pts: number | null | undefined): 'upside' | 'downside' | null {
  if (rr25Pts == null || !Number.isFinite(rr25Pts)) return null;
  if (Math.abs(rr25Pts) < RR_FLAT_PTS) return null;
  return rr25Pts > 0 ? 'upside' : 'downside';
}

function buildDetail({
  atmIv,
  ivBand,
  term,
  basisPct,
  em,
}: Pick<SurfaceHeadlineInput, 'atmIv' | 'ivBand' | 'term' | 'basisPct'> & { em: ExpectedMove }): string[] {
  const out: string[] = [];

  out.push(`That puts the likely range at $${num(em.lowPrice, 0)} to $${num(em.highPrice, 0)}, about two times in three.`);

  if (atmIv != null && atmIv > 0) {
    const level = `Jumpiness is running at ${Math.round(atmIv * 100)}%`;
    out.push(ivBand ? `${level}, which is ${ivBand} for this market.` : `${level} a year.`);
  }

  if (term && Number.isFinite(term.nearIv) && Number.isFinite(term.farIv)) {
    const gap = (term.farIv - term.nearIv) * 100;
    if (Math.abs(gap) < TERM_FLAT_PTS) {
      out.push('Later expiries are priced about the same as the near ones.');
    } else if (gap > 0) {
      out.push('Later expiries are priced jumpier than the near ones, so the market expects more action further out.');
    } else {
      out.push('Near expiries are priced jumpier than later ones, which usually means something is expected soon.');
    }
  }

  if (basisPct != null && Number.isFinite(basisPct) && Math.abs(basisPct) >= 0.01) {
    const side = basisPct > 0 ? 'above' : 'below';
    out.push(`Settlement is quoted ${Math.abs(basisPct).toFixed(2)}% ${side} the spot price.`);
  }

  return out;
}
