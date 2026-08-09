import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { predictV2Config } from '@/config/predict';
import { ownedPackages, sponsoredTargets } from './sponsor-allowlist';

/** Build the kind bytes for a PTB of bare move-calls (targets only — the allowlist
 *  inspects package/module/function, not arguments, so no object resolution needed). */
async function kindOf(...targets: `${string}::${string}::${string}`[]): Promise<string> {
  const tx = new Transaction();
  for (const target of targets) tx.moveCall({ target });
  return toBase64(await tx.build({ onlyTransactionKind: true }));
}

const SESSIONS = predictV2Config.packages.sessions;
const PREDICT = predictV2Config.packages.predict;
const FOREIGN = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('sponsor-allowlist', () => {
  it('includes the sessions package so gasless arming can be sponsored', () => {
    // The regression this file guards: sessions::authorize_session was refused because
    // the sessions package was missing from the owned set.
    expect(SESSIONS).toBeTruthy();
    expect(ownedPackages().has(normalizeSuiAddress(SESSIONS))).toBe(true);
  });

  it('allows sessions::authorize_session (Google arm-instant-trading bundle)', async () => {
    const kind = await kindOf(`${SESSIONS}::sessions::authorize_session`);
    expect(sponsoredTargets(kind)).toContain(
      `${normalizeSuiAddress(SESSIONS)}::sessions::authorize_session`,
    );
  });

  it('allows a mixed Predict + sessions PTB (the first armed trade)', async () => {
    const kind = await kindOf(
      `${PREDICT}::expiry_market::mint`,
      `${SESSIONS}::sessions::authorize_session`,
    );
    const targets = sponsoredTargets(kind);
    expect(targets).toHaveLength(2);
    expect(targets.some((t) => t.endsWith('::sessions::authorize_session'))).toBe(true);
  });

  it('refuses a call into a package we do not own', async () => {
    const kind = await kindOf(`${FOREIGN}::whatever::do_thing`);
    expect(() => sponsoredTargets(kind)).toThrow(/Refusing to sponsor a call outside the Predict packages/);
  });
});
