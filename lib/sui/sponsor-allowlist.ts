/**
 * lib/sui/sponsor-allowlist.ts — the gas sponsor's package allowlist.
 *
 * The Enoki sponsor (/api/sponsor) pays gas ONLY for calls into packages we own, so
 * it can never be turned into a faucet for arbitrary transactions. The allowlist is
 * derived from the ACTUAL transaction — every move-call target it contains, each
 * verified to live in one of our packages — rather than a hand-maintained function
 * list that silently 400'd the moment a flow called something nobody remembered to
 * add. Extracted here so the gating is unit-tested (see sponsor-allowlist.test).
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { predictConfig, predictV2Config } from '@/config/predict';

/** Package IDs the sponsor is willing to pay gas for — our own deployments only.
 *  Normalized to canonical 0x-form so comparison against a tx's targets is exact.
 *  Empty ids (a package not published on the active deployment) are dropped. */
export function ownedPackages(): Set<string> {
  const ids = [
    predictConfig.packageId,
    predictConfig.hedgePackageId,
    predictConfig.skewFeePackageId,
    predictV2Config.packages.predict,
    predictV2Config.packages.account,
    // Delegated instant trading: a Google (gasless) user ARMS a session by bundling
    // `sessions::authorize_session` into their first sponsored trade, and ENDS it via
    // a sponsored `sessions::revoke_session`. Both ride the Enoki sponsor, so the
    // sessions package must be sponsorable or arming refuses. See sessions-delegated-trading.
    predictV2Config.packages.sessions,
  ];
  return new Set(ids.filter(Boolean).map((id) => normalizeSuiAddress(id)));
}

const SUI_FRAMEWORK = normalizeSuiAddress('0x2');

/**
 * Sui-framework coin plumbing that `coinWithBalance` legitimately injects when the
 * sender's funds live as an Address Balance (the accumulator / fast path) rather than
 * owned Coin objects: the SDK withdraws the balance and calls `coin::redeem_funds`
 * (or `balance::redeem_funds`) to materialize a `Coin<T>`. It operates only on the
 * SENDER's OWN withdrawn balance and can't drain the sponsor, so it's safe to pay gas
 * for. Without this, a gasless (Google/Enoki) trade whose DUSDC sits as an address
 * balance is refused here before it ever reaches Enoki. As Sui migrates coins ->
 * address balances this affects more wallets. See Sui "Address Balances"; same class
 * of gap as the sessions package. `sponsoredTargets` still RETURNS these so Enoki's
 * own allowedMoveCallTargets includes them.
 */
const ALLOWED_FRAMEWORK_TARGETS = new Set<string>([
  `${SUI_FRAMEWORK}::coin::redeem_funds`,
  `${SUI_FRAMEWORK}::balance::redeem_funds`,
]);

/**
 * Derive the sponsor allowlist from the transaction kind bytes: every move-call
 * target the tx contains, each verified to live in one of our packages (plus a tiny
 * set of safe Sui-framework coin-redemption calls the SDK injects for address
 * balances). A call anywhere else is refused up front. Targets are returned exactly
 * as parsed, so their normalization matches what Enoki reads from the same bytes.
 * Throws on a foreign call (caller maps it to a 400).
 */
export function sponsoredTargets(kindB64: string): string[] {
  const { commands } = Transaction.fromKind(fromBase64(kindB64)).getData() as unknown as {
    commands: { MoveCall?: { package: string; module: string; function: string } }[];
  };
  const owned = ownedPackages();
  const targets = new Set<string>();
  for (const cmd of commands) {
    const mc = cmd.MoveCall;
    if (!mc) continue; // native command (split/merge/transfer) — no target to gate
    const pkg = normalizeSuiAddress(mc.package);
    const target = `${pkg}::${mc.module}::${mc.function}`;
    if (!owned.has(pkg) && !ALLOWED_FRAMEWORK_TARGETS.has(target)) {
      throw new Error(`Refusing to sponsor a call outside the Predict packages: ${target}`);
    }
    targets.add(target);
  }
  return [...targets];
}
