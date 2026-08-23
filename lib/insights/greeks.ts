/**
 * lib/insights/greeks.ts — how a single binary/range contract BEHAVES.
 *
 * The ladder + scanner answer "is this priced right?". This answers the two
 * questions a trader asks right after: "what happens if BTC MOVES?" and "what
 * happens if it just SITS THERE?" — i.e. the position's sensitivities (delta /
 * gamma / theta) and a full what-if payoff across a spot range (the scenario
 * curve the Payoff & decay panel draws).
 *
 * Everything bottoms out on ONE repricing closure, `makeFairAt(spec, svi)`, which
 * returns the contract's fair chance at any hypothetical forward and any time-
 * scaling of the remaining variance. That single source keeps the greeks, the
 * mark-now curve, and the decay estimate perfectly consistent with the surface
 * math elsewhere (`upFair`/`dnFair`/`rangeFair`) — at timeScale = 1 the closure is
 * byte-for-byte the same formula.
 *
 * The math (all fair-value, no spread — §6.1, this is the visualization spine):
 *   • delta  = ∂chance/∂F      (probability per $1 of forward), central-difference
 *   • gamma  = ∂delta/∂F
 *   • vega   = ∂chance/∂σ per VOL POINT, modelled by scaling the whole smile's vol by
 *              the ratio (σ_atm + 1pt)/σ_atm — i.e. every strike's vol moves together,
 *              an additive point at the money and proportionally less in the wings. A
 *              real vol shock reshapes the smile; this is the parallel-shift version,
 *              which is the honest one to draw from a single surface snapshot.
 *   • theta  = ∂chance/∂t per HOUR, holding annualized vol constant — modelled by
 *              shrinking the remaining total variance in proportion to the time
 *              left (w = σ²·T, hold σ, decay T). Signed: an out-of-the-money bet
 *              bleeds toward $0 (θ < 0); a deep in-the-money binary is worth < 100%
 *              now but resolves to 100%, so time passing HELPS it (θ > 0).
 *   • scenario = the mark-now curve (smooth) + the at-expiry step, across a spot
 *                range framed on the surface's own expected move.
 *
 * Honest limits: this is a "sticky-strike" what-if — it holds the current smile
 * fixed and moves the underlying (or shrinks time). A real move reshapes the smile
 * too, so treat the curve as the surface's own best guess, not a promise. Pure +
 * deterministic + unit-tested (CLAUDE.md §6.5): no fetch, no React.
 */
import { normalCdf } from '@/lib/svi/normal';
import { logMoneyness, totalVarianceAtK, timeToExpiryYears, MS_PER_YEAR, type SviFloat } from '@/lib/svi/svi';

const ONE_HOUR_YEARS = 3_600_000 / MS_PER_YEAR;
/** One implied-vol "point" = 1% annualized, the unit a desk quotes vol changes in. */
const VOL_POINT = 0.01;

/** A binary (up/down at a strike) or a vertical range (band) contract. */
export type ContractSpec =
  | { kind: 'binary'; strike: number; isUp: boolean }
  | { kind: 'range'; lower: number; higher: number };

export interface GreeksInput {
  spec: ContractSpec;
  /** The market's live forward ($) — the reference the trade settles against. */
  forward: number;
  svi: SviFloat;
  expiryMs: number;
  /** Reference clock (ms) — pass the feed timestamp, not Date.now() (CLAUDE.md). */
  now: number;
}

export interface ContractGreeks {
  /** Current fair chance of this contract paying (0..1). */
  fair: number;
  /** ∂chance/∂F per $1 of forward (probability per dollar). Signed. */
  delta: number;
  /** ∂delta/∂F (probability per dollar²). */
  gamma: number;
  /** ∂chance/∂σ for a +1 implied-vol POINT, in probability (signed). Positive for an
   *  out-of-the-money bet (more vol, more chance of getting there), negative for one
   *  already in the money (more vol, more chance of losing it again). */
  vegaPerVolPoint: number;
  /** ∂chance/∂t per HOUR, holding annualized vol (probability points/hr, signed).
   *  For a sub-hour market this is the AVERAGE rate over the remaining life, so it
   *  never extrapolates past expiry. */
  thetaPerHour: number;
  /** Years to expiry at `now` (lets the caller pick per-minute vs per-hour copy). */
  tYears: number;
}

/** One point on the what-if payoff, in fair-chance space (the caller scales to $). */
export interface ScenarioPoint {
  /** Hypothetical forward ($). */
  forward: number;
  /** Signed move from the current forward, as a fraction (0.01 = +1%). */
  move: number;
  /** Marked-to-market chance NOW at this forward, holding the smile (0..1). */
  mark: number;
  /** At-expiry outcome at this forward (0 or 1 for a binary; range likewise). */
  expiry: number;
}

/** UP fair from an explicit total variance — mirrors `upFair` exactly at w = the
 *  live variance, and lets theta shrink w with the time left. */
function upFromVar(k: number, w: number): number {
  if (w <= 0) return k < 0 ? 1 : 0;
  const d2 = -((k + w / 2) / Math.sqrt(w));
  return normalCdf(d2);
}

/** UP chance for a strike at a hypothetical forward, with the remaining variance
 *  scaled by `timeScale` (1 = now, 0 = at expiry). */
function upScaled(strike: number, forward: number, svi: SviFloat, timeScale: number): number {
  const k = logMoneyness(strike, forward);
  return upFromVar(k, totalVarianceAtK(k, svi) * timeScale);
}

/** Build the single repricing closure every figure derives from: the contract's
 *  fair chance at any forward, with the remaining variance scaled by `timeScale`. */
function makeFairAt(spec: ContractSpec, svi: SviFloat): (forward: number, timeScale?: number) => number {
  if (spec.kind === 'range') {
    const { lower, higher } = spec;
    return (forward, timeScale = 1) => upScaled(lower, forward, svi, timeScale) - upScaled(higher, forward, svi, timeScale);
  }
  const { strike, isUp } = spec;
  return (forward, timeScale = 1) => {
    const up = upScaled(strike, forward, svi, timeScale);
    return isUp ? up : 1 - up;
  };
}

/** Delta / gamma / theta for a contract, all from finite differences on the shared
 *  repricing closure (so they can never drift from the mark-now curve). */
export function contractGreeks({ spec, forward, svi, expiryMs, now }: GreeksInput): ContractGreeks {
  const fairAt = makeFairAt(spec, svi);
  const fair = fairAt(forward);

  // Central difference on the forward for delta/gamma. A small relative bump keeps
  // it well inside the quotable band without under-resolving a steep near-expiry
  // smile; floored at $1 so a degenerate forward can't collapse h to zero.
  const h = Math.max(1, forward * 1e-4);
  const fp = fairAt(forward + h);
  const fm = fairAt(forward - h);
  const delta = (fp - fm) / (2 * h);
  const gamma = (fp - 2 * fair + fm) / (h * h);

  // Theta: hold spot + annualized vol, advance time → the remaining total variance
  // shrinks in proportion (w = σ²·T). Advance one hour, or the whole remaining life
  // if it's under an hour, then normalize the change back to a per-hour rate.
  const T = timeToExpiryYears(expiryMs, now);
  let thetaPerHour = 0;
  if (T > 0) {
    const dt = Math.min(ONE_HOUR_YEARS, T);
    const later = fairAt(forward, Math.max(0, (T - dt) / T));
    thetaPerHour = (later - fair) / (dt / ONE_HOUR_YEARS);
  }

  // Vega: scale the remaining variance by ((σ+1pt)/σ)², which is exactly a +1 point
  // parallel shift AT THE MONEY (w = σ²·T), and reprice through the same closure.
  const wAtm = totalVarianceAtK(0, svi);
  const sigmaAtm = T > 0 ? Math.sqrt(Math.max(0, wAtm) / T) : 0;
  const ratio = sigmaAtm > 0 ? (sigmaAtm + VOL_POINT) / sigmaAtm : 1;
  const vegaPerVolPoint = sigmaAtm > 0 ? fairAt(forward, ratio * ratio) - fair : 0;

  return { fair, delta, gamma, thetaPerHour, vegaPerVolPoint, tYears: T };
}

/** A reusable repricer for the caller (chart marker readout): the contract's fair
 *  chance now at any hypothetical forward, holding the current smile. */
export function repricer({ spec, svi }: Pick<GreeksInput, 'spec' | 'svi'>): (forward: number) => number {
  const fairAt = makeFairAt(spec, svi);
  return (forward) => fairAt(forward);
}

/** At-expiry outcome (0/1) for a contract at a hypothetical settlement. */
export function settlesInMoney(spec: ContractSpec, forward: number): boolean {
  if (spec.kind === 'range') return forward > spec.lower && forward <= spec.higher;
  return spec.isUp ? forward > spec.strike : forward <= spec.strike;
}

/** A sensible ±span for the scenario, framed on the surface's own ATM move so the
 *  curve always covers the realistic range without hard-coding a width. */
export function defaultSpan(svi: SviFloat): number {
  const sigma = Math.sqrt(Math.max(0, totalVarianceAtK(0, svi)));
  return Math.min(0.2, Math.max(0.004, sigma * 3));
}

/** The what-if payoff across a spot range: the smooth mark-now curve + the at-
 *  expiry step, in fair-chance space (the panel scales both to dollars per stake).
 *  Dense by default so the range's two jumps and the binary's one render crisp. */
export function scenarioCurve(
  input: GreeksInput,
  opts: { spanPct?: number; steps?: number } = {},
): ScenarioPoint[] {
  const { spec, forward, svi } = input;
  const span = opts.spanPct ?? defaultSpan(svi);
  const steps = Math.max(8, opts.steps ?? 81);
  const fairAt = makeFairAt(spec, svi);
  const lo = forward * (1 - span);
  const hi = forward * (1 + span);
  const out: ScenarioPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = lo + ((hi - lo) * i) / steps;
    out.push({
      forward: f,
      move: forward > 0 ? f / forward - 1 : 0,
      mark: fairAt(f),
      expiry: settlesInMoney(spec, f) ? 1 : 0,
    });
  }
  return out;
}
