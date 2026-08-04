/**
 * lib/sui/v2/strategy-mint.ts — turn a multi-leg strategy into a batch of budget
 * mints. The per-leg SIZING is not re-implemented here: it delegates to the same
 * `planBinaryBudgetMint` / `planRangeBudgetMint` the ticket and co-pilot use, so a
 * strategy leg and a hand-placed bet can never size differently. This module adds
 * only the two things a batch needs on top of that shared sizing:
 *
 *   1. Placement is sequential — every leg is an independent position keyed by its
 *      own (lower_tick, higher_tick), so there's no atomic PTB to assemble; the
 *      caller loops `acct.mintBudget(plan.params)` over the returned plans.
 *   2. The per-leg DEPOSIT is computed against a DECREMENTING account balance, so a
 *      basket that fits the account deposits nothing and one that doesn't tops up
 *      the wrapper exactly once — never over-depositing from the wallet.
 *
 * Strategies are always 1× (the engine keeps the payoff a clean bounded step; the
 * ticket owns leverage + knockout for a single bet). Pure + unit-tested (§6.5).
 */
import { planBinaryBudgetMint, planRangeBudgetMint } from './budget-mint';
import type { SviFloat } from '@/lib/svi/svi';
import type { Leg } from '@/lib/strategy/strategy';
import type { MintBudgetParams } from './predict-tx';
import type { V2Market } from '@/lib/api/v2/types';

export interface PlannedLeg {
  leg: Leg;
  /** Ready for `acct.mintBudget(...)` — the wrapperId is filled in by the hook. */
  params: Omit<MintBudgetParams, 'wrapperId'>;
  /** Fair chance used to size this leg (0..1). */
  entryProb: number;
  /** The staked premium for this leg (DUSDC base units). */
  stakeBase: bigint;
  /** Estimated all-in cost (stake + fee), DUSDC base units. */
  estCostBase: bigint;
  /** Entry probability sits inside the quotable band. */
  probOk: boolean;
  /** Stake clears the chain's $1 minimum net premium. */
  stakeOk: boolean;
}

export interface StrategyMintPlan {
  plans: PlannedLeg[];
  /** Sum of every leg's estimated all-in cost. */
  totalCostBase: bigint;
  /** Sum of every leg's wallet → account deposit (the shortfall the mints cover). */
  totalDepositBase: bigint;
  /** Every leg is quotable and clears the minimum stake. */
  allValid: boolean;
}

export function planStrategyMints(input: {
  market: V2Market;
  pricer: { forward: number; svi: SviFloat };
  legs: Leg[];
  /** The trading account's current DUSDC balance (base units). */
  balanceBase: bigint;
}): StrategyMintPlan {
  const { market, pricer, legs, balanceBase } = input;
  const forward = pricer.forward;
  const svi = pricer.svi;

  let running = balanceBase; // projected account balance as legs consume it
  let totalCostBase = 0n;
  let totalDepositBase = 0n;
  let allValid = legs.length > 0;
  const plans: PlannedLeg[] = [];

  for (const leg of legs) {
    const plan =
      leg.kind === 'binary'
        ? planBinaryBudgetMint({ market, forward, svi, strikePrice: leg.strike, isUp: leg.isUp, stake: leg.stake, leverage: 1 })
        : planRangeBudgetMint({ market, forward, svi, lower: leg.lower, higher: leg.higher, stake: leg.stake, leverage: 1 });

    // Deposit only the shortfall against the RUNNING balance, so a basket that fits
    // the account deposits nothing, and one that doesn't tops up exactly once.
    const shortfall = plan.maxCost > running ? plan.maxCost - running : 0n;

    plans.push({
      leg,
      entryProb: plan.entryProb,
      stakeBase: plan.stakeBase,
      estCostBase: plan.estCostBase,
      probOk: plan.probOk,
      stakeOk: plan.stakeOk,
      params: { ...plan.mint, deposit: shortfall > 0n ? shortfall : undefined },
    });

    if (!plan.probOk || !plan.stakeOk) allValid = false;
    totalCostBase += plan.estCostBase;
    totalDepositBase += shortfall;
    running = running + shortfall - plan.estCostBase;
    if (running < 0n) running = 0n;
  }

  return { plans, totalCostBase, totalDepositBase, allValid };
}
