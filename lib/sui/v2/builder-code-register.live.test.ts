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
import { predictV2Config, ACTIVE_V2_DEPLOYMENT, V2_IS_821_PLUS } from '@/config/predict';
import { buildRegisterBuilderCodeTx } from './builder-code';

const SENDER = process.env.REGISTER_SENDER;
const INDEX = BigInt(process.env.REGISTER_INDEX ?? '0');
const RUN = process.env.RUN_LIVE === '1' && !!SENDER;

interface ChangedObject {
  objectId?: string;
  idOperation?: string;
  outputOwner?: { $kind?: string };
}
interface SimResult {
  Transaction?: {
    status?: { success?: boolean; error?: unknown };
    effects?: { changedObjects?: ChangedObject[] };
  };
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

    const status = res.Transaction?.status;
    if (!status?.success) {
      // An already-used (owner, index) pair aborts here. That is a real answer, not a
      // transport problem: move to the next index rather than retrying this one.
      const err = JSON.stringify(status?.error ?? {});
      expect.fail(`registration would abort: ${err}`);
    }

    const created = (res.Transaction?.effects?.changedObjects ?? []).filter((o) => o.idOperation === 'Created');
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
    console.log(`  ${V2_IS_821_PLUS ? 'NEXT_PUBLIC_BUILDER_CODE_ID_821' : 'NEXT_PUBLIC_BUILDER_CODE_ID'}=${code?.objectId}`);
    console.log(`\nThe id is derived from (sender, index), so the real transaction produces this`);
    console.log(`same id as long as it is signed by ${String(SENDER).slice(0, 12)}… at index ${INDEX}.`);
  }, 60_000);
});
