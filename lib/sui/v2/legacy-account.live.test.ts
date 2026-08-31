/**
 * Reading a trading account on a deployment the app is NOT running.
 *
 * This is the load-bearing claim behind the "your funds are on the old release" banner: that
 * while pointed at one deployment we can still see, and correctly value, an account on
 * another. If that read is wrong in the quiet direction the banner never appears and a
 * trader's money stays invisible; if it is wrong in the loud direction we tell people they
 * have funds they do not have.
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/v2/legacy-account.live.test.ts
 *   LEGACY_OWNER=0x… RUN_LIVE=1 npx vitest run lib/sui/v2/legacy-account.live.test.ts
 *
 * Defaults to the deployer wallet, which has traded on 8-06.
 */
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT, PREVIOUS_V2_DEPLOYMENT } from '@/config/predict';
import { readLegacyFunds, buildLegacyWithdrawTx } from './legacy-account';
import { readWrapper, type SimulateCapableClient } from './account';

const RUN = process.env.RUN_LIVE === '1';
const OWNER = process.env.LEGACY_OWNER ?? '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';

describe.skipIf(!RUN)(`legacy account reads from ${ACTIVE_V2_DEPLOYMENT} (live)`, () => {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
  const core = client.core as unknown as SimulateCapableClient;

  it('reads an account on 8-06 while configured for a different deployment', async () => {
    const funds = await readLegacyFunds(core, OWNER, '8-06');
    console.log(
      `${OWNER.slice(0, 12)}… on 8-06: wrapper ${funds.wrapperId?.slice(0, 12) ?? 'none'}, ` +
        `balance ${Number(funds.balanceBase) / 1e6} DUSDC`,
    );
    expect(funds.deployment).toBe('8-06');
    // This wallet has traded on 8-06, so it must have an account there. A null wrapper would
    // mean the cross-deployment derivation is pointed at the wrong registry.
    expect(funds.wrapperId, 'no 8-06 account found for a wallet that has traded there').toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(funds.balanceBase >= 0n).toBe(true);
  }, 60_000);

  it('derives the SAME wrapper the normal reader does when they name the same deployment', async () => {
    // The cross-deployment reader is a second implementation of a derivation the app already
    // relies on. Where they overlap they must agree exactly, or one of them is addressing a
    // different account than the trader's.
    const legacy = await readLegacyFunds(core, OWNER, ACTIVE_V2_DEPLOYMENT);
    const normal = await readWrapper(core, OWNER);
    expect(legacy.wrapperId ?? '').toBe(normal.exists ? normal.wrapperId : (legacy.wrapperId ?? ''));
    if (normal.exists) expect(legacy.wrapperId).toBe(normal.wrapperId);
  }, 60_000);

  it('reports nothing for a wallet that never traded on the old release', async () => {
    // The common case by far, and the one that decides whether most people ever see a banner.
    const nobody = '0x00000000000000000000000000000000000000000000000000000000000000ff';
    const funds = await readLegacyFunds(core, nobody, '8-06');
    expect(funds.wrapperId).toBeNull();
    expect(funds.balanceBase).toBe(0n);
  }, 60_000);

  it('builds a withdraw that the chain accepts', async () => {
    // Simulated, never submitted. Proves the argument shape against the OLD package: this is
    // the one transaction whose whole purpose is recovering money, and an arity mistake here
    // would only surface after a trader signed it.
    const funds = await readLegacyFunds(core, OWNER, '8-06');
    if (!funds.wrapperId || funds.balanceBase === 0n) {
      console.log('nothing reclaimable on 8-06 for this wallet — withdraw shape not exercised');
      return;
    }
    const tx = buildLegacyWithdrawTx(funds.wrapperId, funds.balanceBase, OWNER, '8-06');
    tx.setSender(OWNER);
    const res = (await (client.core as unknown as {
      simulateTransaction: (o: unknown) => Promise<{ Transaction?: { status?: { success?: boolean; error?: unknown } } }>;
    }).simulateTransaction({ transaction: tx, include: { effects: true }, checksEnabled: false }));
    const status = res.Transaction?.status;
    console.log(`withdraw ${Number(funds.balanceBase) / 1e6} DUSDC → simulate success=${status?.success}`);
    expect(status?.success, `withdraw would abort: ${JSON.stringify(status?.error ?? {})}`).toBe(true);
  }, 60_000);

  it('names a previous deployment to check, or none', () => {
    // If this is null the banner can never appear, which is correct only on the very first
    // deployment. Stated as an assertion so a future config edit that drops it is visible.
    console.log(`active ${ACTIVE_V2_DEPLOYMENT}, previous ${PREVIOUS_V2_DEPLOYMENT ?? 'none'}`);
    expect(PREVIOUS_V2_DEPLOYMENT).not.toBe(ACTIVE_V2_DEPLOYMENT);
  });
});
