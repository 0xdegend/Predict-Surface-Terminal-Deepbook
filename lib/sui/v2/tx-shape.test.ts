/**
 * Pins the ARGUMENT COUNT of every money-moving moveCall, per deployment.
 *
 * A Move entry function is positional. Passing one argument too many or too few does not
 * fail to compile, does not fail a type check, and does not fail until the transaction
 * is already signed and submitted, at which point it aborts against real funds. When the
 * counts happen to match but the ORDER is wrong it does not even abort: it spends the
 * wrong number as a cost cap.
 *
 * 8-21 removed leverage, which subtracted an argument from both mint builders, and made a
 * settled claim all-or-nothing, which subtracted `close_quantity` from both settled-redeem
 * builders. Every one of those spends money, so the counts are pinned here.
 *
 * The SESSION package moved differently, and assuming otherwise is exactly the mistake this
 * file now guards. 8-21 also inserted a shared `SessionsConfig` as the fourth argument of
 * every session entry point. On the mint and settled-redeem paths that INSERTION CANCELS THE
 * REMOVAL: one argument out, one in, arity unchanged. A count check alone would have called
 * those "fine" while the arguments after position 3 were all shifted by one — a signed,
 * unattended session trade passing the pricer where the config belongs. So the session
 * builders are checked by count AND by the position of the config object.
 *
 * The counts WE build (ctx excluded), read off the live package ABIs on 2026-08-31:
 *
 *                            8-06   8-21
 *   mint_exact_quantity        13     12   (-leverage)
 *   mint_exact_amount          13     12   (-leverage)
 *   redeem_settled              8      7   (-close_quantity)
 *   redeem_live                11     11   (unchanged)
 *   session mint_exact_*       13     13   (-leverage, +SessionsConfig)
 *   session redeem_settled      8      8   (-close_quantity, +SessionsConfig)
 *   session redeem_live        11     12   (+SessionsConfig)
 *   authorize_session           4      5   (+SessionsConfig)
 *
 * Run under both deployments, because a single run only ever proves one column:
 *   npx vitest run lib/sui/v2/tx-shape.test.ts
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 npx vitest run lib/sui/v2/tx-shape.test.ts
 */
import { describe, it, expect } from 'vitest';
import { V2_IS_821_PLUS, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { buildMintBudgetTx, buildMintTx, buildRedeemLiveTx, buildRedeemSettledTx } from './predict-tx';
import {
  buildSessionMintTx,
  buildSessionMintBudgetTx,
  buildSessionRedeemSettledTx,
  buildSessionRedeemLiveTx,
} from './session-tx';
import { buildAuthorizeSessionTx } from './session';
import { predictV2Config } from '@/config/predict';
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

/**
 * These builders are inspected UNBUILT (no network), so every object input is still an
 * `UnresolvedObject` — it only becomes SharedObject/ImmOrOwned after `tx.build()` resolves
 * it against a node. Read the id from whichever form is present.
 */
interface TxInput {
  UnresolvedObject?: { objectId: string };
  Object?: { SharedObject?: { objectId: string }; ImmOrOwnedObject?: { objectId: string } };
}
const inputId = (i: TxInput | undefined): string | null =>
  i?.UnresolvedObject?.objectId ?? i?.Object?.SharedObject?.objectId ?? i?.Object?.ImmOrOwnedObject?.objectId ?? null;

/** The object ids a transaction's inputs carry, for asserting an argument's identity. */
function objectInputsOf(tx: Transaction): string[] {
  const data = tx.getData() as unknown as { inputs: TxInput[] };
  return data.inputs.map(inputId).filter((v): v is string => !!v);
}

/** The object id passed as argument `index` of the last moveCall, or null. */
function argObjectAt(tx: Transaction, index: number): string | null {
  const data = tx.getData() as unknown as {
    inputs: TxInput[];
    commands: { MoveCall?: { arguments: { Input?: number }[] } }[];
  };
  const calls = data.commands.filter((c) => c.MoveCall);
  const arg = calls[calls.length - 1]?.MoveCall?.arguments[index];
  return arg?.Input == null ? null : inputId(data.inputs[arg.Input]);
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

  it('keeps the session builders at the arity the sessions package actually wants', () => {
    // Sessions fire without a wallet popup, so a wrong count here fails unattended, in the
    // middle of an Autopilot run, with nobody watching. These do NOT simply lose an argument
    // on 8-21: the config insertion offsets the leverage removal on three of the four.
    expect(lastCallArgs(buildSessionMintTx(mint))).toBe(13);
    expect(lastCallArgs(buildSessionMintBudgetTx(budget))).toBe(13);
    expect(lastCallArgs(buildSessionRedeemSettledTx(redeem))).toBe(8);
    expect(lastCallArgs(buildSessionRedeemLiveTx({ ...redeem, minProbability: 0n, minProceeds: 0n }))).toBe(
      noLeverage ? 12 : 11,
    );
  });

  it('puts SessionsConfig in the fourth slot on 8-21, and nowhere on 8-06', () => {
    // The insertion is what a count check cannot see. Assert the OBJECT is at index 3, so a
    // future edit that keeps the arity right but reorders the arguments still fails here.
    const cfg = predictV2Config.shared.sessionsConfig;
    for (const tx of [
      buildSessionMintTx(mint),
      buildSessionMintBudgetTx(budget),
      buildSessionRedeemSettledTx(redeem),
      buildSessionRedeemLiveTx({ ...redeem, minProbability: 0n, minProceeds: 0n }),
    ]) {
      const inputs = objectInputsOf(tx);
      if (noLeverage) {
        expect(cfg, 'shared.sessionsConfig must be configured on 8-21').toBeTruthy();
        expect(argObjectAt(tx, 3), 'SessionsConfig is not the 4th argument').toBe(cfg);
      } else {
        expect(inputs).not.toContain(cfg ?? '__none__');
      }
    }
  });

  it('inserts SessionsConfig as the SECOND argument of authorize_session', () => {
    // A different position from the trade builders, and the one call that gates every
    // session trade that follows it. Getting it wrong turns instant trading off entirely.
    const tx = buildAuthorizeSessionTx({
      wrapperId: WRAPPER,
      sessionAddress: '0x3333333333333333333333333333333333333333333333333333333333333333',
      durationMs: 3_600_000,
    });
    expect(lastCallArgs(tx)).toBe(noLeverage ? 5 : 4);
    if (noLeverage) expect(argObjectAt(tx, 1)).toBe(predictV2Config.shared.sessionsConfig);
  });

  it('never sends a leverage argument on a protocol that removed leverage', () => {
    // Belt and braces on the count check: prove the DROPPED argument is the leverage one by
    // building the same call at two leverages and requiring identical bytes on 8-21 only.
    // Run for the SESSION mint too — there the arity is unchanged, so this is the only
    // check that can tell "leverage removed and config added" from "nothing happened".
    for (const build of [buildMintTx, buildSessionMintTx]) {
      const a = build({ ...mint, leverage: 1_000_000_000n }).getData();
      const b = build({ ...mint, leverage: 3_000_000_000n }).getData();
      expect(JSON.stringify(a) === JSON.stringify(b)).toBe(noLeverage);
    }
  });
});
