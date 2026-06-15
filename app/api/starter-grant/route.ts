/**
 * /api/starter-grant — app-run DUSDC drip faucet for first-time traders.
 *
 * A fresh wallet lacks the trading asset (DUSDC). This route sends a small, fixed
 * amount of DUSDC from an app-controlled TREASURY wallet straight to the user's
 * wallet, so they never have to leave for an external faucet. Their normal mint
 * then pulls that DUSDC from wallet → manager (the deposit is owner-gated, so the
 * treasury can't fund a manager directly — a wallet transfer is the clean path).
 *
 * GAS: zkLogin (Google) accounts execute gaslessly via Enoki, so they need no SUI.
 * EXTERNAL wallets pay their own SUI gas, so for them — and only them — we ALSO
 * drip a little SUI (split off the treasury's gas coin in the same tx) when their
 * SUI balance is near zero, so a brand-new wallet can make its first trades. The
 * client signals this with `includeSui` (true for external wallets, false for
 * Google); the server still gates it on the recipient's actual SUI balance.
 *
 * These are REAL funds, and zkLogin wallets are cheap to mint, so every payout
 * is gated server-side BEFORE we sign anything:
 *   1. one grant per address — durable, cross-instance ledger (lib/server/grant-store),
 *   2. an in-flight lock so two concurrent requests can't both pay one address,
 *   3. balance gate — skip wallets that already hold DUSDC,
 *   4. global daily cap (shared counter),
 *   5. treasury circuit breaker — refuse when the treasury runs low.
 * Any refusal returns a `code` the client uses to fall back to the faucet link.
 *
 * The ledger is Redis-backed (Upstash via the Vercel marketplace), so dedup and
 * the daily cap survive redeploys AND are shared across Vercel's serverless
 * instances. Without a store configured it degrades to in-process state; the
 * balance gate (3) is the hard anti-double-fund backstop in that case.
 */
import { NextResponse } from 'next/server';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { predictConfig } from '@/config/predict';
import {
  STARTER_GRANT_BASE_DEFAULT,
  STARTER_GRANT_BALANCE_CEILING,
} from '@/config/starter-grant';
import {
  hasGranted,
  acquireLock,
  releaseLock,
  markGranted,
  dailyCount,
  bumpDaily,
} from '@/lib/server/grant-store';

const envBigInt = (name: string, fallback: bigint): bigint => {
  const v = process.env[name];
  try {
    return v ? BigInt(v) : fallback;
  } catch {
    return fallback;
  }
};

/** Amount paid per grant (base units, @6dec). */
const GRANT_BASE = envBigInt('STARTER_GRANT_BASE', STARTER_GRANT_BASE_DEFAULT);
/** Only fund wallets below this DUSDC balance (base units, @6dec). */
const BALANCE_CEILING = envBigInt('STARTER_GRANT_BALANCE_CEILING', STARTER_GRANT_BALANCE_CEILING);
/** Max grants per UTC day across all users (circuit breaker on spend). */
const DAILY_CAP = Number(process.env.STARTER_GRANT_DAILY_CAP ?? '200');
/** Keep at least this much DUSDC in the treasury (base units) — refuse below it. */
const TREASURY_FLOOR = envBigInt('STARTER_GRANT_TREASURY_FLOOR', GRANT_BASE);

/** SUI dripped to a low-SUI external wallet so it can pay its own gas (MIST, @9dec).
 *  Default 0.05 SUI. */
const SUI_GRANT = envBigInt('STARTER_GRANT_SUI_BASE', 50_000_000n);
/** Only drip SUI to wallets below this SUI balance (MIST). Default 0.01 SUI. */
const SUI_CEILING = envBigInt('STARTER_GRANT_SUI_CEILING', 10_000_000n);
/** Keep at least this much SUI in the treasury for its own gas on top of the drip
 *  (MIST). Default 0.1 SUI. */
const SUI_GAS_RESERVE = envBigInt('STARTER_GRANT_SUI_RESERVE', 100_000_000n);

const QUOTE = predictConfig.quote.coinType;
const SUI = '0x2::sui::SUI';

/** Lazily build the treasury keypair from STARTER_GRANT_PRIVATE_KEY (a
 *  `suiprivkey1...` bech32 string). Returns null when unconfigured. */
let treasury: Ed25519Keypair | null | undefined;
function getTreasury(): Ed25519Keypair | null {
  if (treasury !== undefined) return treasury;
  const key = process.env.STARTER_GRANT_PRIVATE_KEY;
  treasury = key ? Ed25519Keypair.fromSecretKey(key) : null;
  return treasury;
}

// gRPC client (matches the app's lib/sui/dapp-kit.ts). Same fullnode the rest of
// the app reads from, so balances + execution stay consistent.
const client = new SuiGrpcClient({
  network: predictConfig.network,
  baseUrl: process.env.STARTER_GRANT_RPC_URL ?? predictConfig.grpcUrl,
});

async function balanceOf(owner: string, coinType: string): Promise<bigint> {
  const r = await client.core.getBalance({ owner, coinType });
  return BigInt(r.balance.balance);
}

export async function POST(req: Request) {
  const signer = getTreasury();
  if (!signer) {
    return NextResponse.json(
      { error: 'Starter grant not configured', code: 'not_configured' },
      { status: 503 },
    );
  }

  let address: string | undefined;
  let includeSui = false;
  try {
    ({ address, includeSui = false } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'bad_request' }, { status: 400 });
  }
  if (!address || !isValidSuiAddress(address)) {
    return NextResponse.json({ error: 'Invalid address', code: 'bad_request' }, { status: 400 });
  }

  // 1) one grant per address (durable, survives redeploys + shared across instances).
  if (await hasGranted(address)) {
    return NextResponse.json(
      { error: 'This wallet has already been funded', code: 'already_funded' },
      { status: 429 },
    );
  }

  // 4) global daily cap.
  if ((await dailyCount()) >= DAILY_CAP) {
    return NextResponse.json(
      { error: 'Daily funding limit reached — try the faucet', code: 'rate_limited' },
      { status: 429 },
    );
  }

  // 2) take the in-flight lock — refuse if another request is already mid-payout
  //    for this address (kills the double-pay race the done-check alone can't).
  if (!(await acquireLock(address))) {
    return NextResponse.json(
      { error: 'A grant for this wallet is already in progress', code: 'in_progress' },
      { status: 409 },
    );
  }

  try {
    // 3) balance gate — never top up a wallet that already has DUSDC.
    if ((await balanceOf(address, QUOTE)) >= BALANCE_CEILING) {
      await markGranted(address); // they don't need it; don't re-check them.
      return NextResponse.json(
        { error: 'Wallet already holds enough DUSDC', code: 'already_funded' },
        { status: 409 },
      );
    }

    // 5) treasury circuit breaker — leave the DUSDC floor untouched.
    const treasuryAddr = signer.toSuiAddress();
    if ((await balanceOf(treasuryAddr, QUOTE)) < TREASURY_FLOOR + GRANT_BASE) {
      return NextResponse.json(
        { error: 'Treasury is low — try the faucet', code: 'treasury_empty' },
        { status: 503 },
      );
    }

    // SUI drip (external wallets only): include it when the client asked AND the
    // recipient is near-zero on SUI AND the treasury can spare it on top of its
    // own gas reserve. Best-effort — if the treasury is low on SUI we still send
    // the DUSDC rather than fail the whole grant.
    const dripSui =
      includeSui &&
      (await balanceOf(address, SUI)) < SUI_CEILING &&
      (await balanceOf(treasuryAddr, SUI)) >= SUI_GRANT + SUI_GAS_RESERVE;

    // Build + sign + execute the transfer (treasury pays its own gas in SUI).
    const tx = new Transaction();
    tx.setSender(treasuryAddr);
    const dusdc = tx.add(coinWithBalance({ type: QUOTE, balance: GRANT_BASE }));
    const recipient = tx.pure.address(address);
    if (dripSui) {
      // Split the SUI drip off the gas coin (the treasury's own SUI) — same tx.
      const [sui] = tx.splitCoins(tx.gas, [SUI_GRANT]);
      tx.transferObjects([dusdc, sui], recipient);
    } else {
      tx.transferObjects([dusdc], recipient);
    }

    const res = await client.core.signAndExecuteTransaction({ signer, transaction: tx });
    if (res.$kind === 'FailedTransaction') {
      throw new Error(res.FailedTransaction.status?.error?.message ?? 'Transfer failed on-chain');
    }
    const digest = res.Transaction.digest;
    await client.core.waitForTransaction({ digest });

    // Persist the marker + bump the counter only after success, so a failed
    // payout leaves no permanent mark and can be retried.
    await markGranted(address, digest);
    await bumpDaily();
    return NextResponse.json({
      digest,
      amount: GRANT_BASE.toString(),
      suiAmount: dripSui ? SUI_GRANT.toString() : '0',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Grant failed';
    return NextResponse.json({ error: msg, code: 'error' }, { status: 502 });
  } finally {
    // Always free the in-flight lock; the permanent `done` marker (set above on
    // success) is what prevents re-claims, not the lock.
    await releaseLock(address);
  }
}
