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
import { predictConfig } from '@/config/predict';

const enoki = process.env.ENOKI_PRIVATE_API_KEY
  ? new EnokiClient({ apiKey: process.env.ENOKI_PRIVATE_API_KEY })
  : null;

/** Move-call targets the sponsor will pay for (every moveCall in a sponsored PTB
 *  must be listed, incl. the key constructors used inside mint/redeem). */
function allowedMoveCallTargets(): string[] {
  const pkg = predictConfig.packageId;
  const targets = [
    `${pkg}::predict::create_manager`,
    `${pkg}::predict::mint`,
    `${pkg}::predict::redeem`,
    `${pkg}::predict::redeem_permissionless`,
    `${pkg}::predict::mint_range`,
    `${pkg}::predict::redeem_range`,
    `${pkg}::predict::withdraw`,
    `${pkg}::predict_manager::deposit`,
    `${pkg}::predict_manager::withdraw`,
    `${pkg}::market_key::new`,
    `${pkg}::range_key::new`,
  ];
  if (predictConfig.hedgePackageId) {
    targets.push(`${predictConfig.hedgePackageId}::hedged_position::open_hedged_and_keep`);
  }
  return targets;
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
      const sponsored = await enoki.createSponsoredTransaction({
        network: predictConfig.network as EnokiNetwork,
        transactionKindBytes: body.transactionKindBytes,
        sender: body.sender,
        allowedMoveCallTargets: allowedMoveCallTargets(),
        // Restrict transfer recipients to those the client declared (e.g. a
        // cash-out destination + the sender). Undefined ⇒ no address restriction.
        allowedAddresses: body.allowedAddresses,
      });
      return NextResponse.json({ bytes: sponsored.bytes, digest: sponsored.digest });
    }

    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sponsor request failed';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
