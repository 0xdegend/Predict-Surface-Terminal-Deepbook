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
