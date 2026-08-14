// TEMPORARY diagnostic — surfaces the error the style indexer seed swallows. DELETE after.
import { NextResponse } from 'next/server';
import { scanEventsSince, onchainSkewOwners } from '@/lib/api/v2/onchain';
import { predictV2Config } from '@/config/predict';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const out: Record<string, unknown> = {
    pkg: predictV2Config.packages.predict,
    builderCodeId: predictV2Config.builderCodeId,
    featuredWallets: predictV2Config.featuredWallets,
  };
  try {
    const r = await scanEventsSince(
      { MoveEventType: `${predictV2Config.packages.predict}::order_events::OrderMinted` },
      null,
      2,
    );
    out.scan = { count: r.events.length, cursor: r.cursor, sample: r.events[0]?.parsedJson ?? null };
  } catch (e) {
    out.scanError = { message: String(e), stack: (e as Error)?.stack?.split('\n').slice(0, 8) };
  }
  try {
    out.codeOwners = predictV2Config.builderCodeId
      ? (await onchainSkewOwners(predictV2Config.builderCodeId)).length
      : 'no-code';
  } catch (e) {
    out.codeOwnersError = String(e);
  }
  return NextResponse.json(out);
}
