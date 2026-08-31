/**
 * Pins the ARGUMENT COUNT of every money-moving moveCall, per deployment.
 *
 * A Move entry function is positional. Passing one argument too many or too few does not
 * fail to compile, does not fail a type check, and does not fail until the transaction
 * is already signed and submitted, at which point it aborts against real funds. When the
 * counts happen to match but the ORDER is wrong it does not even abort: it spends the
 * wrong number as a cost cap.
 *
 * 8-21 removed leverage from the protocol, which subtracted an argument from both mint
 * builders, and made a settled claim all-or-nothing, which subtracted `close_quantity`
 * from both settled-redeem builders. Every one of those is a path that spends money, so
 * the counts are asserted here against the Move sources they were read from:
 *
 * Move params (ctx included) → the count WE build (ctx excluded):
 *
 *   mint_exact_quantity     14 → 13 on 8-06   13 → 12 on 8-21   (-leverage)
 *   mint_exact_amount       14 → 13 on 8-06   13 → 12 on 8-21   (-leverage)
 *   redeem_settled           9 →  8 on 8-06    8 →  7 on 8-21   (-close_quantity)
 *   redeem_live             12 → 11 on both                     (unchanged)
 *
 * The session variants swap the `Auth` hot potato for the account registry, which is why
 * their counts match the owner builders rather than being one lower.
 *
 * Run under both deployments, because a single run only ever proves one column:
 *   npx vitest run lib/sui/v2/tx-shape.test.ts
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 npx vitest run lib/sui/v2/tx-shape.test.ts
 */
import { describe, it, expect } from 'vitest';
import { V2_IS_821_PLUS, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { buildMintBudgetTx, buildMintTx, buildRedeemLiveTx, buildRedeemSettledTx } from './predict-tx';
import { buildSessionMintTx, buildSessionMintBudgetTx, buildSessionRedeemSettledTx } from './session-tx';
import type { Transaction } from '@mysten/sui/transactions';

const MARKET = '0x1111111111111111111111111111111111111111111111111111111111111111';
const WRAPPER = '0x2222222222222222222222222222222222222222222222222222222222222222';

/** How many arguments the LAST moveCall in a built transaction carries. */
function lastCallArgs(tx: Transaction): number {
  const data = tx.getData() as unknown as {
    commands: { MoveCall?: { arguments: unknown[]; function: string } }[];
  };
  const calls = data.commands.filter((cmd) => cmd.MoveCall);
  const last = calls[calls.length - 1]?.MoveCall;
  if (!last) throw new Error('no moveCall in transaction');
  return last.arguments.length;
}

const mint = {
  marketId: MARKET,
  wrapperId: WRAPPER,
  lowerTick: 1n,
  higherTick: 2n,
  quantity: 1_000_000n,
  leverage: 1_000_000_000n,
  maxCost: 5_000_000n,
  maxProbability: 900_000_000n,
};
const budget = {
  marketId: MARKET,
  wrapperId: WRAPPER,
  lowerTick: 1n,
  higherTick: 2n,
  amount: 5_000_000n,
  minQuantity: 1n,
  leverage: 1_000_000_000n,
  maxCost: 5_000_000n,
};
const redeem = { marketId: MARKET, wrapperId: WRAPPER, orderId: 7n, closeQuantity: 1_000_000n };

describe(`money-path argument counts (${ACTIVE_V2_DEPLOYMENT})`, () => {
  const noLeverage = V2_IS_821_PLUS;

  it('mint_exact_quantity drops leverage exactly on 8-21', () => {
    expect(lastCallArgs(buildMintTx(mint))).toBe(noLeverage ? 12 : 13);
  });

  it('mint_exact_amount drops leverage exactly on 8-21', () => {
    expect(lastCallArgs(buildMintBudgetTx(budget))).toBe(noLeverage ? 12 : 13);
  });

  it('redeem_settled drops close_quantity exactly on 8-21', () => {
    expect(lastCallArgs(buildRedeemSettledTx(redeem))).toBe(noLeverage ? 7 : 8);
  });

  it('redeem_live is untouched by 8-21', () => {
    // The one money path the republish did NOT change. Asserted so a future edit that
    // "tidies" the leverage branch cannot quietly take an argument off it too.
    const args = lastCallArgs(buildRedeemLiveTx({ ...redeem, minProbability: 0n, minProceeds: 0n }));
    expect(args).toBe(11);
  });

  it('applies the same subtraction to the session builders', () => {
    // Sessions fire without a wallet popup, so a wrong count here fails unattended,
    // in the middle of an Autopilot run, with nobody watching.
    expect(lastCallArgs(buildSessionMintTx(mint))).toBe(noLeverage ? 12 : 13);
    expect(lastCallArgs(buildSessionMintBudgetTx(budget))).toBe(noLeverage ? 12 : 13);
    expect(lastCallArgs(buildSessionRedeemSettledTx(redeem))).toBe(noLeverage ? 7 : 8);
  });

  it('never sends a leverage argument on a protocol that removed leverage', () => {
    // Belt and braces on the count check: prove the DROPPED argument is the leverage
    // one by building the same mint at two different leverages and requiring the
    // transactions to be identical on 8-21 and to differ everywhere else.
    const a = buildMintTx({ ...mint, leverage: 1_000_000_000n }).getData();
    const b = buildMintTx({ ...mint, leverage: 3_000_000_000n }).getData();
    const same = JSON.stringify(a) === JSON.stringify(b);
    expect(same).toBe(noLeverage);
  });
});
