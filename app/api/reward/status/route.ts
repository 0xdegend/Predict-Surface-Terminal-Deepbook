/**
 * GET /api/reward/status?address=0x.. — is this wallet eligible for the reward, and
 * has it already claimed? Drives the banner + claim experience so neither shows to an
 * ineligible or already-claimed wallet. Reads the frozen allowlist + the claim ledger
 * server-side; returns only booleans + the public amount (never the allowlist itself).
 */
import { NextResponse } from 'next/server';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { isRewardEligible, REWARD_DUSDC, REWARD_BASE_UNITS, REWARD_CAMPAIGN } from '@/lib/rewards/eligibility';
import { hasRewardClaim } from '@/lib/server/reward-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get('address');
  const base = { campaign: REWARD_CAMPAIGN, amountDusdc: REWARD_DUSDC, amountBaseUnits: REWARD_BASE_UNITS.toString() };
  if (!address || !isValidSuiAddress(address) || !isRewardEligible(address)) {
    return NextResponse.json({ ...base, eligible: false, claimed: false }, { headers: { 'cache-control': 'no-store' } });
  }
  const claimed = await hasRewardClaim(REWARD_CAMPAIGN, address).catch(() => false);
  return NextResponse.json(
    { ...base, eligible: true, claimed },
    { headers: { 'cache-control': 'no-store' } },
  );
}
