/**
 * lib/sui/funding.ts — how a mint is funded.
 *
 * A mint pays from the manager's FREE BALANCE first; only the shortfall is
 * pulled from the wallet now (deposited into the manager in the same PTB). We
 * add a small buffer over the quoted cost so a tick between quote and signing
 * doesn't under-fund the mint and revert.
 *
 * This is the one piece of money math the binary ticket, range ticket, and the
 * surface quick-mint popover must agree on — keep it here so they never drift.
 */

/** Buffer the quoted cost by 2% to absorb price movement between quote + sign. */
export const MINT_COST_BUFFER_BPS = 102n; // → cost * 102 / 100

/**
 * Given a chain-quoted `mintCost` (base units, @6dec) and the manager's current
 * free `tradingBalanceBase`, return how much DUSDC to deposit from the wallet in
 * this transaction. `depositAmount` is also exactly what "leaves your wallet
 * now" — the rest of the cost is covered by the free balance already in the
 * manager.
 */
export function fundingSplit(
  mintCost: bigint,
  tradingBalanceBase: bigint,
): { depositAmount: bigint; buffered: bigint } {
  const buffered = (mintCost * MINT_COST_BUFFER_BPS) / 100n;
  const depositAmount = buffered > tradingBalanceBase ? buffered - tradingBalanceBase : 0n;
  return { depositAmount, buffered };
}

/** The Skew builder fee on a given cost, in DUSDC base units. `feeBps` is read
 *  live from the on-chain FeeConfig (100 = 1.00%). */
export function skewFee(cost: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  return (cost * BigInt(feeBps)) / 10_000n;
}

/**
 * Size the single payment coin handed to the `skew_fee` router (`mint_with_fee` /
 * `mint_range_with_fee`). The router takes its fee from this coin and deposits the
 * rest into the manager, so the coin must cover BOTH the fee and the deposit the
 * mint needs. We buffer the fee on the buffered cost too, so a price tick between
 * quote and signing can't under-fund it; any excess simply lands back in the
 * user's manager free balance (never lost).
 *
 * `fee` is the nominal fee on the *quoted* cost — the figure to SHOW the user.
 */
export function feeRouterPayment(
  mintCost: bigint,
  tradingBalanceBase: bigint,
  feeBps: number,
): { fee: bigint; depositAmount: bigint; paymentAmount: bigint } {
  const { depositAmount, buffered } = fundingSplit(mintCost, tradingBalanceBase);
  const fee = skewFee(mintCost, feeBps);
  const feeBuffered = skewFee(buffered, feeBps);
  return { fee, depositAmount, paymentAmount: depositAmount + feeBuffered };
}
