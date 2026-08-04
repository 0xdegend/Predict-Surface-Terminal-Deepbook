/**
 * lib/strategy/strategy.ts — the multi-leg strategy engine (pure).
 *
 * A strategy is a basket of LONG binary/range legs on ONE expiry. Because every
 * leg is a bought cash-or-nothing claim (pays $1·qty if it wins, else $0), the
 * combined payoff at expiry is a step function of the settlement price, and the
 * whole thing has a bounded downside: you can never lose more than the total
 * premium. That lets us give a trader the four numbers an options desk lives on —
 * net cost, max win, max loss, breakevens — plus a surface-derived chance of
 * profit, all exactly, with no shorting and no margin.
 *
 * Every dollar is at 1× (no leverage) so the payoff stays a clean step with the
 * "max loss = premium" invariant intact; the ticket owns leverage + knockout for a
 * single bet. The economics mirror the ticket's budget-mint sizing: a $s stake at
 * fair p buys ~$s/p of payout, and the fee rides the payout (see lib/sui/v2/quote).
 *
 * The mark-now overlay (what the basket is worth if you exit now) reuses the
 * Phase-2 `repricer`, so the strategy diagram and the single-bet payoff panel
 * speak the same surface. Pure + deterministic + unit-tested (CLAUDE.md §6.5).
 */
import { upFair, dnFair, rangeFair, type SviFloat } from '@/lib/svi/svi';
import { repricer, settlesInMoney, type ContractSpec } from '@/lib/insights/greeks';

/** One long leg: a binary (up/down at a strike) or a vertical range (band). */
export type Leg =
  | { id: string; kind: 'binary'; strike: number; isUp: boolean; stake: number }
  | { id: string; kind: 'range'; lower: number; higher: number; stake: number };

export interface Pricer {
  forward: number;
  svi: SviFloat;
}

/** The surface contract for a leg (for repricing / in-the-money tests). */
export function legSpec(leg: Leg): ContractSpec {
  return leg.kind === 'binary'
    ? { kind: 'binary', strike: leg.strike, isUp: leg.isUp }
    : { kind: 'range', lower: leg.lower, higher: leg.higher };
}

/** The leg's fair chance of paying, now (0..1). */
export function legFair(leg: Leg, pricer: Pricer): number {
  if (leg.kind === 'binary') {
    return leg.isUp ? upFair(leg.strike, pricer.forward, pricer.svi) : dnFair(leg.strike, pricer.forward, pricer.svi);
  }
  return rangeFair(leg.lower, leg.higher, pricer.forward, pricer.svi);
}

export interface LegEcon {
  leg: Leg;
  /** Fair chance the leg pays (0..1), floored off zero for the sizing math. */
  prob: number;
  /** Max payout of the leg ($) — what it pays if it wins. */
  payout: number;
  /** Protocol fee for the leg ($) — rides the payout. */
  fee: number;
  /** All-in cost of the leg ($) = stake + fee. */
  cost: number;
}

/** Size one leg the way the budget-mint ticket does: $stake at fair p → $stake/p of
 *  payout, fee on the payout. */
export function legEconomics(leg: Leg, pricer: Pricer, feeRate: number): LegEcon {
  const prob = Math.min(Math.max(legFair(leg, pricer), 1e-6), 1);
  const payout = leg.stake / prob;
  const fee = Math.max(0, feeRate) * payout;
  return { leg, prob, payout, fee, cost: leg.stake + fee };
}

export interface Strategy {
  legs: LegEcon[];
  pricer: Pricer;
  totalStake: number;
  totalFee: number;
  /** All-in premium ($) — what you pay, and the most you can lose. */
  netCost: number;
  /** Sum of every leg's max payout ($) — the ceiling if they ALL win. */
  totalMaxPayout: number;
  /** Distinct settlement prices where the combined payoff steps (sorted). */
  breakpoints: number[];
}

export function buildStrategy(rawLegs: Leg[], pricer: Pricer, feeRate: number): Strategy {
  const legs = rawLegs.map((l) => legEconomics(l, pricer, feeRate));
  const totalStake = legs.reduce((s, e) => s + e.leg.stake, 0);
  const totalFee = legs.reduce((s, e) => s + e.fee, 0);
  const totalMaxPayout = legs.reduce((s, e) => s + e.payout, 0);
  const bp = new Set<number>();
  for (const e of legs) {
    if (e.leg.kind === 'binary') bp.add(e.leg.strike);
    else {
      bp.add(e.leg.lower);
      bp.add(e.leg.higher);
    }
  }
  const breakpoints = [...bp].sort((a, b) => a - b);
  return { legs, pricer, totalStake, totalFee, netCost: totalStake + totalFee, totalMaxPayout, breakpoints };
}

/** Gross payoff ($) if the market settles at `settlement` — sum of the winning legs. */
export function grossPayoffAt(s: Strategy, settlement: number): number {
  let sum = 0;
  for (const e of s.legs) if (settlesInMoney(legSpec(e.leg), settlement)) sum += e.payout;
  return sum;
}

/** Net P&L ($) at a settlement price = gross payoff − premium paid. */
export function pnlAt(s: Strategy, settlement: number): number {
  return grossPayoffAt(s, settlement) - s.netCost;
}

/** Per-leg repricers, built once, for the smooth mark-now curve. */
export function legRepricers(s: Strategy): Array<(forward: number) => number> {
  return s.legs.map((e) => repricer({ spec: legSpec(e.leg), svi: s.pricer.svi }));
}

/** Mark-now P&L ($) if the forward were `forward` (holds the smile) — the value if
 *  you exited now, netted against the premium. Pass repricers from `legRepricers`. */
export function markAt(s: Strategy, reprs: Array<(forward: number) => number>, forward: number): number {
  let sum = 0;
  for (let i = 0; i < s.legs.length; i++) sum += s.legs[i].payout * reprs[i](forward);
  return sum - s.netCost;
}

export interface StrategyStats {
  netCost: number;
  /** Best-case P&L ($). */
  maxWin: number;
  /** Worst-case P&L ($) — ≤ 0; equals −netCost whenever some region wins nothing. */
  maxLoss: number;
  /** Settlement prices where the P&L crosses zero. */
  breakevens: number[];
  /** Surface probability the settlement lands in a profitable region (0..1). */
  chanceOfProfit: number;
}

export function strategyStats(s: Strategy): StrategyStats {
  const bps = s.breakpoints;
  if (s.legs.length === 0 || bps.length === 0) {
    return { netCost: s.netCost, maxWin: 0, maxLoss: 0, breakevens: [], chanceOfProfit: 0 };
  }
  // A representative settlement inside each of the n+1 payoff intervals.
  const spread = Math.max(bps[bps.length - 1] - bps[0], s.pricer.forward * 0.02, 1);
  const reps: number[] = [bps[0] - spread];
  for (let i = 1; i < bps.length; i++) reps.push((bps[i - 1] + bps[i]) / 2);
  reps.push(bps[bps.length - 1] + spread);

  const pnls = reps.map((r) => pnlAt(s, r));
  const maxWin = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);

  // A breakeven sits at any breakpoint whose two neighbouring intervals straddle
  // zero (the payoff jumps across the premium line right there).
  const breakevens: number[] = [];
  for (let j = 0; j < bps.length; j++) {
    if (pnls[j] < 0 !== pnls[j + 1] < 0) breakevens.push(bps[j]);
  }

  // Chance of profit: the surface mass over every profitable interval. For an
  // interval (lo, hi], P = P(S > lo) − P(S > hi) = upFair(lo) − upFair(hi).
  const survive = (x: number) => (x === -Infinity ? 1 : x === Infinity ? 0 : upFair(x, s.pricer.forward, s.pricer.svi));
  const edges = [-Infinity, ...bps, Infinity];
  let chanceOfProfit = 0;
  for (let j = 0; j < reps.length; j++) {
    if (pnls[j] > 0) chanceOfProfit += Math.max(0, survive(edges[j]) - survive(edges[j + 1]));
  }

  return { netCost: s.netCost, maxWin, maxLoss, breakevens, chanceOfProfit: Math.min(1, Math.max(0, chanceOfProfit)) };
}

// ——— Presets: one-tap starting shapes, seeded around the money ———

export type PresetKind = 'breakout' | 'bull_ladder' | 'bear_ladder' | 'pin';

export const PRESETS: { kind: PresetKind; label: string; blurb: string }[] = [
  { kind: 'breakout', label: 'Breakout', blurb: 'Wins on a big move either way' },
  { kind: 'bull_ladder', label: 'Bull ladder', blurb: 'Pays more the higher BTC finishes' },
  { kind: 'bear_ladder', label: 'Bear ladder', blurb: 'Pays more the lower BTC finishes' },
  { kind: 'pin', label: 'Pin range', blurb: 'Wins if BTC stays near here' },
];

/** Build a preset's legs around the money. `atm`/`width` should already be on the
 *  admission grid (the caller snaps). `stake` is the per-leg dollar stake. */
export function presetLegs(kind: PresetKind, atm: number, width: number, stake: number): Leg[] {
  const w = Math.max(1, width);
  switch (kind) {
    case 'breakout':
      return [
        { id: 'breakout-dn', kind: 'binary', strike: atm - w, isUp: false, stake },
        { id: 'breakout-up', kind: 'binary', strike: atm + w, isUp: true, stake },
      ];
    case 'bull_ladder':
      return [0, 1, 2].map((i) => ({ id: `bull-${i}`, kind: 'binary', strike: atm + i * w, isUp: true, stake }));
    case 'bear_ladder':
      return [0, 1, 2].map((i) => ({ id: `bear-${i}`, kind: 'binary', strike: atm - i * w, isUp: false, stake }));
    case 'pin':
      return [{ id: 'pin-0', kind: 'range', lower: atm - w, higher: atm + w, stake }];
  }
}
