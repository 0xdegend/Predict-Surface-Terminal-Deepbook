// TEMPORARY diagnostic — replicates the style seed stage-by-stage with timing + error
// capture, to find why the real seed returns empty. DELETE after.
import { NextResponse } from 'next/server';
import { scanEventsSince, onchainSkewOwners, onchainOwnerOrders } from '@/lib/api/v2/onchain';
import { predictV2Config } from '@/config/predict';
import { LEGACY_OWNERS } from '@/lib/leaderboard/legacy-carryover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ms = () => Date.now();

export async function GET() {
  const out: Record<string, unknown> = {};
  const filter = { MoveEventType: `${predictV2Config.packages.predict}::order_events::OrderMinted` };

  // Stage 1: full backfill (40 pages), as the real seed does.
  let t = ms();
  try {
    const r = await scanEventsSince(filter, null, 40);
    out.backfill = { count: r.events.length, ms: ms() - t };
  } catch (e) {
    out.backfillError = { message: String(e), stack: (e as Error)?.stack?.split('\n').slice(0, 6), ms: ms() - t };
  }

  // Stage 2: owner set.
  const code = predictV2Config.builderCodeId;
  const codeOwners = code ? await onchainSkewOwners(code).catch(() => [] as string[]) : [];
  const owners = [
    ...new Set([...codeOwners, ...LEGACY_OWNERS, ...predictV2Config.featuredWallets].map((o) => o.toLowerCase())),
  ];
  out.ownerCount = owners.length;

  // Stage 3: the parallel fan-out, timed. This is the suspected bottleneck.
  t = ms();
  try {
    const results = await Promise.all(
      owners.map((o) => onchainOwnerOrders(o, 300).catch((e) => ({ __err: String(e) }) as unknown as unknown[])),
    );
    let ok = 0;
    let failed = 0;
    let mints = 0;
    for (const r of results) {
      if (Array.isArray(r)) {
        ok += 1;
        mints += r.filter((e) => (e as { kind?: string }).kind === 'order_minted').length;
      } else {
        failed += 1;
      }
    }
    out.fanout = { ownerOk: ok, ownerFailed: failed, mints, ms: ms() - t };
  } catch (e) {
    out.fanoutError = { message: String(e), stack: (e as Error)?.stack?.split('\n').slice(0, 6), ms: ms() - t };
  }

  return NextResponse.json(out);
}
