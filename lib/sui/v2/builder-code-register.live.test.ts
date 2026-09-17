/**
 * A dry run of the builder-code registration, so the transaction is proven before it is
 * signed rather than after.
 *
 * Registration is one-way. The signer becomes the code's permanent owner, there is no
 * reassignment, and an (owner, index) pair can only be used once because the object is
 * derived from exactly that key. A failed attempt is cheap; a wrong one is not, and it is
 * the sort of mistake only discovered later, when fees have been accruing to a code whose
 * key nobody holds.
 *
 * This simulates the real builder against the real registry, from the address that will
 * actually sign. Nothing is submitted and nothing is signed.
 *
 *   REGISTER_SENDER=0x… NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
 *     npx vitest run lib/sui/v2/builder-code-register.live.test.ts
 *
 * Optional: REGISTER_INDEX=1 to check another slot if index 0 is already taken.
 *
 * Verified on 2026-08-31: the created object ids are DETERMINISTIC, derived from
 * (sender, index) rather than from the transaction digest. Two simulations return the same
 * ids; a different index or a different sender returns different ones. So this prints the
 * exact BuilderCode id the real transaction will produce, which can be put in .env before
 * signing and checked against afterwards.
 */
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT, BUILDER_CODE_ENV_VAR } from '@/config/predict';
import { buildRegisterBuilderCodeTx } from './builder-code';

const SENDER = process.env.REGISTER_SENDER;
const INDEX = BigInt(process.env.REGISTER_INDEX ?? '0');
const RUN = process.env.RUN_LIVE === '1' && !!SENDER;

interface ChangedObject {
  objectId?: string;
  idOperation?: string;
  outputOwner?: { $kind?: string };
}
interface SimBody {
  status?: { success?: boolean; error?: { message?: string } };
  effects?: { changedObjects?: ChangedObject[] };
}
/**
 * The simulate response is a DISCRIMINATED UNION: a failure arrives under
 * `FailedTransaction`, not under `Transaction`.
 *
 * This file used to read `res.Transaction` unconditionally, which on any failure is
 * `undefined`. So every abort reported itself as the empty string `{}` and the reason was
 * unreachable — including the one that matters, an (owner, index) pair that is already
 * claimed. Reading both arms turns a dead end into an answer.
 */
interface SimResult {
  $kind?: string;
  Transaction?: SimBody;
  FailedTransaction?: SimBody;
}

describe.skipIf(!RUN)(`builder-code registration dry run on ${ACTIVE_V2_DEPLOYMENT}`, () => {
  it('simulates cleanly and names the BuilderCode it would create', async () => {
    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
    const tx = buildRegisterBuilderCodeTx(INDEX);
    tx.setSender(SENDER as string);

    console.log(`deployment : ${ACTIVE_V2_DEPLOYMENT}`);
    console.log(`registry   : ${predictV2Config.shared.registry}`);
    console.log(`sender     : ${SENDER}`);
    console.log(`index      : ${INDEX}`);

    // `effects: true` is required. Without it the response carries an EMPTY effects object
    // and every created id silently reads as absent, which looks like a transaction that
    // creates nothing rather than like a missing field.
    const res = (await client.core.simulateTransaction({
      transaction: tx,
      include: { effects: true },
      checksEnabled: false,
    })) as SimResult;

    const body = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
    if (!body?.status?.success) {
      // An already-used (owner, index) pair aborts with EObjectAlreadyExists. That is a
      // real answer, not a transport problem: move to the next index rather than retrying
      // this one. The BuilderCode id derives from (sender, index) and, as of 9-12, that
      // derivation collides ACROSS deployments — index 0 was spent registering on 8-21, so
      // the same wallet has to use a fresh index on every subsequent release.
      const err = body?.status?.error?.message ?? JSON.stringify(body?.status?.error ?? {});
      expect.fail(`registration would abort at index ${INDEX}: ${err}\n\nTry REGISTER_INDEX=${INDEX + 1n}.`);
    }

    const created = (body.effects?.changedObjects ?? []).filter((o) => o.idOperation === 'Created');
    // Two objects are created. The BuilderCode is the SHARED one; the other is owned by the
    // registry itself (its internal entry keyed by owner+index) and is not what we configure.
    const code = created.find((o) => o.outputOwner?.$kind === 'Shared');
    const entry = created.find((o) => o.outputOwner?.$kind !== 'Shared');

    expect(code?.objectId, 'no shared object would be created — this is not a registration').toMatch(
      /^0x[0-9a-f]{64}$/,
    );

    console.log(`\nSIMULATION OK. Nothing was signed or submitted.`);
    console.log(`  registry entry (not this) : ${entry?.objectId ?? 'n/a'}`);
    console.log(`  BuilderCode               : ${code?.objectId}`);
    console.log(`\nAfter signing the same transaction, set:`);
    console.log(`  ${BUILDER_CODE_ENV_VAR[ACTIVE_V2_DEPLOYMENT]}=${code?.objectId}`);
    console.log(`\nThe id is derived from (sender, index), so the real transaction produces this`);
    console.log(`same id as long as it is signed by ${String(SENDER).slice(0, 12)}… at index ${INDEX}.`);
  }, 60_000);
});
