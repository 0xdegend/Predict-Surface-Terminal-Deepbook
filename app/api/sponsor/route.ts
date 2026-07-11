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
import { predictConfig, predictV2Config } from '@/config/predict';
import { installEnokiTrace } from '@/lib/sui/enoki-trace';

// Debug tracing of the raw api.enoki.mystenlabs.com request/response (URL +
// Request-Id + bodies) — active only when ENOKI_DEBUG is set. See enoki-trace.ts.
installEnokiTrace();

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
    `${pkg}::predict::supply`,
    `${pkg}::predict::withdraw`,
    `${pkg}::predict_manager::deposit`,
    `${pkg}::predict_manager::withdraw`,
    `${pkg}::market_key::new`,
    `${pkg}::range_key::new`,
  ];
  if (predictConfig.hedgePackageId) {
    targets.push(`${predictConfig.hedgePackageId}::hedged_position::open_hedged_and_keep`);
  }
  // Skew builder-fee router: when deployed, mints route through fee_router (which
  // builds the MarketKey/RangeKey internally and composes predict::mint), so the
  // top-level PTB call is fee_router::* — allowlist it or sponsored fee-mints 403.
  if (predictConfig.skewFeePackageId) {
    targets.push(
      `${predictConfig.skewFeePackageId}::fee_router::mint_with_fee`,
      `${predictConfig.skewFeePackageId}::fee_router::mint_range_with_fee`,
    );
  }
  // NEW (v2) deployment — account custody, expiry-market trading, async vault.
  // Every moveCall in a sponsored v2 PTB must be here (generate_auth and
  // load_live_pricer run inline in most flows), or Enoki rejects the create
  // phase with a 4xx regardless of the portal settings.
  const v2 = predictV2Config.packages;
  if (v2.account) {
    targets.push(
      `${v2.account}::account::generate_auth`,
      `${v2.account}::account::share`,
      `${v2.account}::account::deposit_funds`,
      `${v2.account}::account::withdraw_funds`,
      `${v2.account}::account_registry::new`,
    );
  }
  if (v2.predict) {
    targets.push(
      `${v2.predict}::expiry_market::load_live_pricer`,
      `${v2.predict}::expiry_market::mint_exact_quantity`,
      `${v2.predict}::expiry_market::redeem_live`,
      `${v2.predict}::expiry_market::redeem_settled`,
      `${v2.predict}::plp::request_supply`,
      `${v2.predict}::plp::request_withdraw`,
      `${v2.predict}::plp::cancel_supply_request`,
      `${v2.predict}::plp::cancel_withdraw_request`,
    );
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
