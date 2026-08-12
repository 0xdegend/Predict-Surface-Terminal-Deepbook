/**
 * POST /api/reward/claim — the Founding Traders reward payout rail.
 *
 * Sends the one-time reward (50 DUSDC) from the reward TREASURY to an eligible wallet.
 * The deposit into their Predict account is owner-gated on-chain (verified: a foreign
 * deposit aborts in account::assert_owner), so the treasury can only reach the WALLET;
 * the client then signs a gasless deposit wallet -> account. For external (Slush)
 * wallets we also drip a little SUI so they can sign that deposit.
 *
 * Every payout is gated server-side BEFORE signing (these are real testnet funds and
 * the allowlist is small):
 *   1. eligibility — the wallet must be on the FROZEN snapshot (lib/rewards/eligibility),
 *   2. one claim per wallet — durable marker = the payout digest,
 *   3. in-flight lock — kills the concurrent double-pay race,
 *   4. treasury floor — refuse if the treasury can't cover this payout.
 *
 * NB: creates its OWN SuiGrpcClient — server routes must NOT import lib/sui/grpc.ts
 * (it pulls in client-only React and breaks the server build).
 */
import { NextResponse } from 'next/server';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { predictV2Config } from '@/config/predict';
import { isRewardEligible, REWARD_BASE_UNITS, REWARD_CAMPAIGN } from '@/lib/rewards/eligibility';
import {
  getRewardClaim,
  isRealRewardPayout,
  acquireRewardLock,
  releaseRewardLock,
  markRewardClaimed,
} from '@/lib/server/reward-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const envBigInt = (name: string, fallback: bigint): bigint => {
  const v = process.env[name];
  try {
    return v ? BigInt(v) : fallback;
  } catch {
    return fallback;
  }
};

const QUOTE = predictV2Config.quote.coinType;
const SUI = '0x2::sui::SUI';

/** Keep at least this much DUSDC in the treasury on top of this payout (base units). */
const TREASURY_FLOOR = envBigInt('REWARD_TREASURY_FLOOR', 0n);
/** SUI dripped to a low-SUI external wallet so it can sign the deposit (MIST). 0.05 SUI. */
const SUI_DRIP = envBigInt('REWARD_SUI_BASE', 50_000_000n);
/** Only drip SUI to wallets below this SUI balance (MIST). Default 0.01 SUI. */
const SUI_CEILING = envBigInt('REWARD_SUI_CEILING', 10_000_000n);
/** Keep this much SUI in the treasury for its own gas beyond the drip (MIST). 0.1 SUI. */
const SUI_GAS_RESERVE = envBigInt('REWARD_SUI_RESERVE', 100_000_000n);

let treasury: Ed25519Keypair | null | undefined;
function getTreasury(): Ed25519Keypair | null {
  if (treasury !== undefined) return treasury;
  const key = process.env.REWARD_TREASURY_PRIVATE_KEY ?? process.env.STARTER_GRANT_PRIVATE_KEY;
  treasury = key ? Ed25519Keypair.fromSecretKey(key) : null;
  return treasury;
}

const client = new SuiGrpcClient({
  network: predictV2Config.network,
  baseUrl: process.env.REWARD_RPC_URL ?? predictV2Config.grpcUrl,
});

async function balanceOf(owner: string, coinType: string): Promise<bigint> {
  const r = await client.core.getBalance({ owner, coinType });
  return BigInt(r.balance.balance);
}

export async function POST(req: Request) {
  const signer = getTreasury();
  if (!signer) {
    return NextResponse.json({ error: 'Reward not configured', code: 'not_configured' }, { status: 503 });
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

  // 1) eligibility — the frozen allowlist is the gate. Never pay a wallet not on it.
  if (!isRewardEligible(address)) {
    return NextResponse.json({ error: 'This wallet is not eligible for the reward', code: 'not_eligible' }, { status: 403 });
  }

  // 2) one claim per wallet.
  if (isRealRewardPayout(await getRewardClaim(REWARD_CAMPAIGN, address))) {
    return NextResponse.json({ error: 'This wallet already claimed its reward', code: 'already_claimed' }, { status: 429 });
  }

  // 3) in-flight lock.
  if (!(await acquireRewardLock(REWARD_CAMPAIGN, address))) {
    return NextResponse.json({ error: 'A claim for this wallet is already in progress', code: 'in_progress' }, { status: 409 });
  }

  try {
    // Re-check under the lock (another request may have just paid it).
    if (isRealRewardPayout(await getRewardClaim(REWARD_CAMPAIGN, address))) {
      return NextResponse.json({ error: 'This wallet already claimed its reward', code: 'already_claimed' }, { status: 429 });
    }

    // 4) treasury floor.
    const treasuryAddr = signer.toSuiAddress();
    if ((await balanceOf(treasuryAddr, QUOTE)) < TREASURY_FLOOR + REWARD_BASE_UNITS) {
      return NextResponse.json({ error: 'Reward treasury is low — try again later', code: 'treasury_empty' }, { status: 503 });
    }

    // Drip SUI to an external wallet that's near-zero, so it can gas the deposit.
    const dripSui =
      includeSui &&
      (await balanceOf(address, SUI)) < SUI_CEILING &&
      (await balanceOf(treasuryAddr, SUI)) >= SUI_DRIP + SUI_GAS_RESERVE;

    // Build + sign + execute: treasury -> user wallet (treasury pays its own gas).
    const tx = new Transaction();
    tx.setSender(treasuryAddr);
    const dusdc = tx.add(coinWithBalance({ type: QUOTE, balance: REWARD_BASE_UNITS }));
    const recipient = tx.pure.address(address);
    if (dripSui) {
      const [sui] = tx.splitCoins(tx.gas, [SUI_DRIP]);
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

    // Mark claimed only after the transfer confirms, so a failure leaves no mark.
    await markRewardClaimed(REWARD_CAMPAIGN, address, digest);
    return NextResponse.json({
      digest,
      amount: REWARD_BASE_UNITS.toString(),
      suiAmount: dripSui ? SUI_DRIP.toString() : '0',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Reward claim failed';
    return NextResponse.json({ error: msg, code: 'error' }, { status: 502 });
  } finally {
    await releaseRewardLock(REWARD_CAMPAIGN, address);
  }
}
