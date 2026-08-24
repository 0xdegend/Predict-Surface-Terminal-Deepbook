/**
 * lib/markets/v2-ladder.ts — the probability ladder for the BTC Options page.
 *
 * A column of strikes around the forward, each one a REAL, admission-snapped,
 * mintable strike (so every rung is one click to a bet), tagged with the surface's
 * chance-above and the payout for betting up to it. We generate by target
 * chance-above (evenly spaced across the quotable band) and then snap to the
 * admission grid via the v2 inversion — so the rungs span the band and always land
 * on a tradeable strike, unlike a fixed $-grid that can fall outside it.
 *
 * PURE + unit-tested. v2-specific (it snaps to v2's admission grid), so it lives
 * here rather than in the asset-neutral engine; the chance-above itself is the
 * engine's `upFair`, so the ladder can't disagree with the surface.
 */
import { upFair, type SviFloat } from '@/lib/svi/svi';
import { strikeForUpFair, payoutMultiple } from '@/lib/sui/v2/invert';
import { toFloat } from '@/config/scale';
import { netPayoutMultiple, NO_FEES, type FeeRates } from './v2-fees';

export interface LadderRung {
  /** Admission-snapped strike ($), guaranteed mintable. */
  strike: number;
  /** The surface's chance the asset finishes ABOVE this strike (0..1). */
  chanceAbove: number;
  /** Signed move from the forward to this strike, in percent. */
  movePct: number;
  /** Payout multiple for an UP bet that reaches this strike (1 / chance-above). */
  payoutUp: number;
  /**
   * The same payout AFTER the trade fee and our own fee — what the trader actually
   * collects per dollar committed. Equals `payoutUp` when no rates are supplied.
   *
   * Both are kept, rather than replacing one with the other, because they answer
   * different questions: `payoutUp` is the surface's price (and must stay equal to
   * `1 / chanceAbove` or the ladder would contradict the surface), while this is the
   * money. The UI quotes this one.
   */
  netPayoutUp: number;
  /** The rung nearest the forward (today's price). */
  isAtm: boolean;
}

/** Chance-above targets, high → low, spanning the quotable band. The ATM (~0.5)
 *  rung is the middle. Kept away from 0/1 where strikes aren't quotable. */
const DEFAULT_TARGETS = [0.82, 0.72, 0.62, 0.5, 0.38, 0.28, 0.18];

/**
 * Build the ladder for one market's pricer. Returns rungs sorted by strike
 * ascending (so chance-above runs high → low, top → bottom), de-duplicated after
 * snapping, with the rung nearest the forward flagged as ATM. Empty when the
 * pricer can't be priced.
 */
export function buildLadder(
  pricer: { forward: number; svi: SviFloat },
  admissionTickSize: string | bigint,
  targets: number[] = DEFAULT_TARGETS,
  /** Fees in force. Omitted → net equals gross, so existing callers are unchanged. */
  rates: FeeRates = NO_FEES,
): LadderRung[] {
  const { forward, svi } = pricer;
  if (!(forward > 0)) return [];

  const seen = new Set<number>();
  const rungs: LadderRung[] = [];
  for (const t of targets) {
    const strike = toFloat(strikeForUpFair(t, forward, svi, admissionTickSize));
    if (!(strike > 0) || seen.has(strike)) continue;
    seen.add(strike);
    const chanceAbove = upFair(strike, forward, svi);
    rungs.push({
      strike,
      chanceAbove,
      movePct: ((strike - forward) / forward) * 100,
      payoutUp: payoutMultiple(chanceAbove),
      netPayoutUp: netPayoutMultiple(chanceAbove, rates),
      isAtm: false,
    });
  }

  rungs.sort((a, b) => a.strike - b.strike);

  if (rungs.length) {
    let atm = 0;
    let best = Infinity;
    rungs.forEach((r, i) => {
      const d = Math.abs(r.strike - forward);
      if (d < best) {
        best = d;
        atm = i;
      }
    });
    rungs[atm].isAtm = true;
  }
  return rungs;
}

/** One side of a rung: the chance it wins, and what it pays gross and net. */
export interface LadderSide {
  /** Chance this side finishes in the money (0..1). */
  chance: number;
  /** Payout multiple at the fair price (1 / chance). */
  payout: number;
  /** Payout after fees — what the trader actually collects per dollar committed. */
  netPayout: number;
}

/**
 * Read a rung from either direction.
 *
 * A binary at strike K has two sides and the ladder only ever showed one, so half of
 * every market was unreachable from the page's flagship table. They are exact mirrors
 * — `chanceBelow = 1 − chanceAbove` — so no new pricing is needed, only the arithmetic
 * to say it. Kept here rather than in the component so the two directions can never
 * drift apart, and so the fee is applied to the side actually being quoted (it is
 * charged on notional, so the down side of a longshot carries a different haircut than
 * the up side).
 */
export function ladderSide(r: LadderRung, isUp: boolean, rates: FeeRates = NO_FEES): LadderSide {
  const chance = isUp ? r.chanceAbove : 1 - r.chanceAbove;
  return {
    chance,
    payout: payoutMultiple(chance),
    netPayout: netPayoutMultiple(chance, rates),
  };
}
