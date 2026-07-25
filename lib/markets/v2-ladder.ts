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

export interface LadderRung {
  /** Admission-snapped strike ($), guaranteed mintable. */
  strike: number;
  /** The surface's chance the asset finishes ABOVE this strike (0..1). */
  chanceAbove: number;
  /** Signed move from the forward to this strike, in percent. */
  movePct: number;
  /** Payout multiple for an UP bet that reaches this strike (1 / chance-above). */
  payoutUp: number;
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
