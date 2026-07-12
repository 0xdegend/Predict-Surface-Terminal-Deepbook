/**
 * /api/sponsor — server-side Enoki gas sponsorship (gasless transactions).
 *
 * Enoki's sponsor endpoints require the PRIVATE api key, so they MUST run on the
 * server (the public key 403s with "Private API key required"). This route holds
 * `ENOKI_PRIVATE_API_KEY` server-side and exposes the two sponsor phases:
 *
 *   create  → { transactionKindBytes, sender }  ⇒ { bytes, digest }
 *   execute → { digest, signature }             ⇒ { digest }
 *
 * The sponsor is constrained to the Predict move-call targets below, so this
 * route can only ever pay gas for Predict actions — never arbitrary transfers.
 * (Note: it sponsors gas only; the user still spends their own DUSDC. For
 * production you'd add rate-limiting / per-user caps on top.)
 */
import { NextResponse } from 'next/server';
import { EnokiClient, type EnokiNetwork } from '@mysten/enoki';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { predictConfig, predictV2Config } from '@/config/predict';
import { installEnokiTrace } from '@/lib/sui/enoki-trace';

// Debug tracing of the raw api.enoki.mystenlabs.com request/response (URL +
// Request-Id + bodies) — active only when ENOKI_DEBUG is set. See enoki-trace.ts.
installEnokiTrace();

const enoki = process.env.ENOKI_PRIVATE_API_KEY
  ? new EnokiClient({ apiKey: process.env.ENOKI_PRIVATE_API_KEY })
  : null;

/** Package IDs the sponsor is willing to pay gas for — our own deployments only,
 *  so it can never be turned into a faucet for arbitrary transactions. Normalized
 *  to canonical 0x-form so comparison against the tx's targets is exact. */
function ownedPackages(): Set<string> {
  const ids = [
    predictConfig.packageId,
    predictConfig.hedgePackageId,
    predictConfig.skewFeePackageId,
    predictV2Config.packages.predict,
    predictV2Config.packages.account,
  ];
  return new Set(ids.filter(Boolean).map((id) => normalizeSuiAddress(id)));
}

/**
 * Derive the sponsor allowlist from the ACTUAL transaction: every move-call
 * target the kind bytes contain, each verified to live in one of our packages.
 *
 * This replaces the old hand-maintained target list, which silently 400'd Enoki's
 * create phase the moment a flow called a function nobody remembered to add
 * (mint_exact_amount, redeem_live/settled, …). Now ANY function in our packages is
 * covered automatically — so gasless flows never break target-by-target — while a
 * call into a package we don't own is refused up front. Targets are passed through
 * exactly as parsed, so their normalization matches what Enoki reads from the same
 * bytes (no stale-string or leading-zero mismatch). Throws → 400 in the caller.
 */
function sponsoredTargets(kindB64: string): string[] {
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

export async function POST(req: Request) {
  if (!enoki) {
    return NextResponse.json({ error: 'Sponsorship not configured (ENOKI_PRIVATE_API_KEY)' }, { status: 500 });
  }

  let body: {
    transactionKindBytes?: string;
    sender?: string;
    allowedAddresses?: string[];
    digest?: string;
    signature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    // Execute phase — sign-then-submit.
    if (body.digest && body.signature) {
      const { digest } = await enoki.executeSponsoredTransaction({
        digest: body.digest,
        signature: body.signature,
      });
      return NextResponse.json({ digest });
    }

    // Create phase — wrap the transaction kind with sponsor gas.
    if (body.transactionKindBytes && body.sender) {
      // Allowlist is derived from the tx itself; a malformed kind or a call into a
      // package we don't sponsor is a client error (400), not an Enoki failure.
      let allowedMoveCallTargets: string[];
      try {
        allowedMoveCallTargets = sponsoredTargets(body.transactionKindBytes);
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 400 });
      }
      const sponsored = await enoki.createSponsoredTransaction({
        network: predictConfig.network as EnokiNetwork,
        transactionKindBytes: body.transactionKindBytes,
        sender: body.sender,
        allowedMoveCallTargets,
        // Restrict transfer recipients to those the client declared (e.g. a
        // cash-out destination + the sender). Undefined ⇒ no address restriction.
        allowedAddresses: body.allowedAddresses,
      });
      return NextResponse.json({ bytes: sponsored.bytes, digest: sponsored.digest });
    }

    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  } catch (e) {
    const phase = body.digest ? 'execute' : 'create';
    // EnokiClientError carries the HTTP status + Enoki's error code; .cause holds
    // their exact message (allowlist, expired reservation, bad signature…). Log
    // all of it server-side so you can hand Enoki the endpoint + status + code
    // while the client toast stays humanized. Add ENOKI_DEBUG=1 for the full
    // request/response trace (URL + Request-Id + bodies) from enoki-trace.ts.
    const err = e as { message?: string; status?: number; code?: string; cause?: unknown };
    const msg = err.message ?? 'Sponsor request failed';
    console.error(
      `[sponsor:${phase}] POST https://api.enoki.mystenlabs.com/v1/transaction-blocks/sponsor${
        phase === 'execute' ? `/${body.digest}` : ''
      } → status=${err.status ?? '?'} code=${err.code ?? '?'} — ${msg}`,
      err.cause ?? '',
    );
    return NextResponse.json({ error: `${phase} phase: ${msg}` }, { status: 502 });
  }
}
