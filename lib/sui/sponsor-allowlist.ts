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
    // The v2 Skew fee: a gasless (Google) trade withdraws the fee from the account
    // (`account::withdraw_funds`, already owned above) and hands it to
    // `skew_fee_v2::fee_router::charge` in the same sponsored PTB, so the router package
    // must be sponsorable or the fee call is refused before it reaches Enoki.
    predictV2Config.skewFeeV2PackageId,
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
 * Sui-framework coin plumbing that `coinWithBalance` / `createBalance` legitimately
 * inject when the sender's funds live as an Address Balance (the accumulator / fast
 * path) rather than owned Coin objects. This is the COMPLETE set the SDK's resolver
 * emits (verified against @mysten/sui CoinWithBalance intent), because it turned out
 * `redeem_funds` alone was not enough — a real gasless wallet was refused on
 * `coin::send_funds`:
 *   - `coin::redeem_funds` / `balance::redeem_funds` — withdraw the sender's address
 *     balance into a `Coin<T>` / `Balance<T>`.
 *   - `coin::send_funds` — return the leftover merged coin to the sender's OWN address
 *     balance after the exact split (the change path).
 *   - `coin::into_balance` — convert a split `Coin<T>` to `Balance<T>` for a balance intent.
 *   - `coin::zero` / `balance::zero` / `coin::destroy_zero` — the zero / cleanup helpers.
 * Every one of these operates only on the SENDER's own coins/balances (passed as
 * arguments) and can't drain the sponsor, so they're safe to pay gas for. Without them
 * a gasless (Google/Enoki) trade whose DUSDC sits as an address balance is refused here
 * before it ever reaches Enoki. As Sui migrates coins -> address balances this affects
 * more wallets. Kept EXACT (not all of 0x2) so the sponsor can't be turned into a
 * free-gas faucet for arbitrary coin shuffling — `0x2::coin::burn` etc. stay refused.
 * `sponsoredTargets` still RETURNS these so Enoki's own allowedMoveCallTargets includes
 * them. If a future SDK adds another injected call, add it here. See Sui "Address
 * Balances"; same class of gap as the sessions package.
 */
const ALLOWED_FRAMEWORK_TARGETS = new Set<string>([
  `${SUI_FRAMEWORK}::coin::redeem_funds`,
  `${SUI_FRAMEWORK}::balance::redeem_funds`,
  `${SUI_FRAMEWORK}::coin::send_funds`,
  `${SUI_FRAMEWORK}::coin::into_balance`,
  `${SUI_FRAMEWORK}::coin::zero`,
  `${SUI_FRAMEWORK}::balance::zero`,
  `${SUI_FRAMEWORK}::coin::destroy_zero`,
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
