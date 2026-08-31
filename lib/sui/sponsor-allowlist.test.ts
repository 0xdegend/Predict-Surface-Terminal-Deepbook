import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { predictV2Config, predictConfigFor, PREVIOUS_V2_DEPLOYMENT } from '@/config/predict';
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

  // The complete set of Sui-framework calls the @mysten/sui CoinWithBalance resolver
  // injects when funds come from an address balance. redeem_funds alone was NOT enough:
  // a real gasless wallet was refused on coin::send_funds (the change-return path).
  const FRAMEWORK_INJECTED = [
    '0x2::coin::redeem_funds',
    '0x2::balance::redeem_funds',
    '0x2::coin::send_funds',
    '0x2::coin::into_balance',
    '0x2::coin::zero',
    '0x2::balance::zero',
    '0x2::coin::destroy_zero',
  ] as const;

  it.each(FRAMEWORK_INJECTED)('allows framework %s (coinWithBalance address-balance plumbing)', async (target) => {
    // Each must be allowed AND returned (so Enoki's allowedMoveCallTargets permits it too).
    const kind = await kindOf(target);
    const [pkg, mod, fn] = target.split('::');
    expect(sponsoredTargets(kind)).toContain(`${normalizeSuiAddress(pkg)}::${mod}::${fn}`);
  });

  it('allows a mixed Predict + framework redeem/send PTB (fund from an address balance, return change)', async () => {
    // Mirrors the live failure: draw DUSDC from the address balance, deposit, send change back.
    const kind = await kindOf(
      '0x2::coin::redeem_funds',
      `${PREDICT}::account::deposit_funds`,
      '0x2::coin::send_funds',
    );
    const targets = sponsoredTargets(kind);
    expect(targets.some((t) => t.endsWith('::coin::redeem_funds'))).toBe(true);
    expect(targets.some((t) => t.endsWith('::account::deposit_funds'))).toBe(true);
    expect(targets.some((t) => t.endsWith('::coin::send_funds'))).toBe(true);
  });

  it('still refuses a framework call outside the address-balance set (allowlist is exact, not all of 0x2)', async () => {
    const kind = await kindOf('0x2::coin::burn');
    expect(() => sponsoredTargets(kind)).toThrow(/Refusing to sponsor a call outside the Predict packages/);
  });
});

describe('the stranded-funds move', () => {
  // The move spans TWO deployments' account packages in one PTB. Its targets are listed
  // here rather than built from buildLegacyMoveTx, because that transaction references
  // shared objects and so cannot be built offline — the allowlist reads only
  // package::module::function, which is exactly what these are.
  const moveTargets = () => {
    const from = predictConfigFor(PREVIOUS_V2_DEPLOYMENT!).packages.account;
    const to = predictV2Config.packages.account;
    return [
      `${from}::account::generate_auth`,
      `${from}::account::withdraw_funds`,
      `${to}::account_registry::new`,
      `${to}::account::generate_auth`,
      `${to}::account::deposit_funds`,
      `${to}::account::share`,
    ] as `${string}::${string}::${string}`[];
  };

  it('owns the PREVIOUS deployment account package, not just the active one', () => {
    // Without this a Google/Enoki trader, who never holds SUI, is refused sponsorship on
    // the single transaction that recovers their own money — and it surfaces as a sponsor
    // error saying nothing about the old release.
    if (PREVIOUS_V2_DEPLOYMENT === null) return;
    const owned = ownedPackages();
    const prev = normalizeSuiAddress(predictConfigFor(PREVIOUS_V2_DEPLOYMENT).packages.account);
    expect(owned.has(prev), `previous deployment account package not sponsorable: ${prev}`).toBe(true);
  });

  it('does NOT own the previous deployment predict package', () => {
    // Deliberately narrow: recovering custody is not the same as being allowed to keep
    // trading a retired release on our gas.
    if (PREVIOUS_V2_DEPLOYMENT === null) return;
    const prevPredict = normalizeSuiAddress(predictConfigFor(PREVIOUS_V2_DEPLOYMENT).packages.predict);
    if (prevPredict === normalizeSuiAddress(predictV2Config.packages.predict)) return; // same pkg, nothing to assert
    expect(ownedPackages().has(prevPredict)).toBe(false);
  });

  it('sponsors every call in the one-transaction move', async () => {
    if (PREVIOUS_V2_DEPLOYMENT === null) return;
    const targets = sponsoredTargets(await kindOf(...moveTargets()));
    expect(targets).toHaveLength(moveTargets().length);
  });

  it('needs no framework coin plumbing', () => {
    // The withdrawn Coin goes straight into deposit_funds, so it never becomes an address
    // balance and the SDK injects none of the 0x2::coin::* helpers. Those were a past
    // source of sponsor refusals, so it is worth pinning that this path avoids them.
    expect(moveTargets().some((t) => t.startsWith(normalizeSuiAddress('0x2')))).toBe(false);
  });
});
