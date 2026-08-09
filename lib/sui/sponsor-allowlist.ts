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

/**
 * Derive the sponsor allowlist from the transaction kind bytes: every move-call
 * target the tx contains, each verified to live in one of our packages. A call into
 * a package we don't own is refused up front. Targets are returned exactly as parsed,
 * so their normalization matches what Enoki reads from the same bytes. Throws on a
 * foreign call (caller maps it to a 400).
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
    if (!owned.has(pkg)) {
      throw new Error(
        `Refusing to sponsor a call outside the Predict packages: ${pkg}::${mc.module}::${mc.function}`,
      );
    }
    targets.add(`${pkg}::${mc.module}::${mc.function}`);
  }
  return [...targets];
}
