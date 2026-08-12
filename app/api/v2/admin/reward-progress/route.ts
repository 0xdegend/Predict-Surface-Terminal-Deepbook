/**
 * GET /api/v2/admin/reward-progress — the Founding Traders reward, at a glance.
 *
 * Joins the claim ledger (how many of the frozen allowlist have claimed) with a live
 * on-chain read of the reward treasury (can it still cover what's left?), so an
 * operator can watch the airdrop and know when to top the treasury up. Returns
 * aggregate counts + treasury balances + a capped list of claim digests — all public
 * on-chain data, never the allowlist or any key. Mirrors the [[wallet-mix-tracking]]
 * admin route.
 *
 * NB: creates its OWN SuiGrpcClient — server routes must NOT import lib/sui/grpc.ts.
 */
import { NextResponse } from 'next/server';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { predictV2Config } from '@/config/predict';
import {
  REWARD_CAMPAIGN,
  REWARD_DUSDC,
  REWARD_ELIGIBLE_COUNT,
  REWARD_TOTAL_DUSDC,
} from '@/lib/rewards/eligibility';
import { listRewardClaimers, getRewardClaim, isRealRewardPayout } from '@/lib/server/reward-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QUOTE = predictV2Config.quote.coinType;
const SUI = '0x2::sui::SUI';
const DUSDC_UNIT = 1_000_000; // 6 decimals
const SUI_UNIT = 1_000_000_000; // 9 decimals (MIST)
/** How many claim digests to surface (public data; keeps per-address reads bounded). */
const RECENT_CAP = 15;

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

async function balanceOf(owner: string, coinType: string): Promise<bigint | null> {
  try {
    const r = await client.core.getBalance({ owner, coinType });
    return BigInt(r.balance.balance);
  } catch {
    return null;
  }
}

export async function GET() {
  // Claim ledger. Each `done` marker is a completed real payout (written only after the
  // transfer confirms), so the count is the claimers length; fetch digests for a capped
  // subset for the explorer links.
  const claimers = await listRewardClaimers(REWARD_CAMPAIGN).catch(() => [] as string[]);
  const claimedCount = claimers.length;
  const shown = claimers.slice(0, RECENT_CAP);
  const digests = await Promise.all(shown.map((a) => getRewardClaim(REWARD_CAMPAIGN, a).catch(() => null)));
  const claimList = shown.map((address, i) => ({
    address,
    digest: isRealRewardPayout(digests[i]) ? digests[i] : null,
  }));

  const perClaimDusdc = REWARD_DUSDC;
  const eligibleCount = REWARD_ELIGIBLE_COUNT;
  const remainingCount = Math.max(0, eligibleCount - claimedCount);
  const paidDusdc = claimedCount * perClaimDusdc;
  const remainingCommittedDusdc = remainingCount * perClaimDusdc;

  // Live treasury read (public on-chain balances of the reward treasury address).
  const signer = getTreasury();
  const address = signer?.toSuiAddress() ?? null;
  const [dusdcBase, suiBase] = address
    ? await Promise.all([balanceOf(address, QUOTE), balanceOf(address, SUI)])
    : [null, null];
  const dusdc = dusdcBase == null ? null : Number(dusdcBase) / DUSDC_UNIT;
  const sui = suiBase == null ? null : Number(suiBase) / SUI_UNIT;

  return NextResponse.json(
    {
      campaign: REWARD_CAMPAIGN,
      perClaimDusdc,
      eligibleCount,
      totalCommittedDusdc: REWARD_TOTAL_DUSDC,
      claimedCount,
      paidDusdc,
      remainingCount,
      remainingCommittedDusdc,
      enabled: process.env.NEXT_PUBLIC_REWARD_ENABLED === '1',
      preview: process.env.NEXT_PUBLIC_REWARD_PREVIEW === '1',
      treasury: {
        configured: !!signer,
        address,
        dusdc,
        sui,
        coversRemaining: dusdc != null && dusdc >= remainingCommittedDusdc,
      },
      claimers: claimList,
      builtAtMs: Date.now(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
