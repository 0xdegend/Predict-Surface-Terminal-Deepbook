/**
 * lib/autopilot/funding.ts — how much money has to move before a live run can start.
 *
 * The arm confirm used to ask this as a question: "Fund it with... Deposit $25, or Use
 * account balance?" Two radio buttons, on the screen where the next tap spends money,
 * for something with exactly one right answer every time. This is that answer.
 *
 * The session key spends the TRADING ACCOUNT balance, not the wallet, so topping the
 * account up to the run's budget is all a run ever needs: an account that already covers
 * the budget moves nothing, and a short one moves only the difference. Pure and tested
 * because it is the amount a wallet signature is taken for.
 */

/** The shortfall between a run's budget and what the trading account already holds, in
 *  quote base units. Never negative: a fuller account tops up nothing. */
export function topUpBase(budgetBase: bigint, balanceBase: bigint): bigint {
  const short = budgetBase - balanceBase;
  return short > 0n ? short : 0n;
}
