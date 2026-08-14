/**
 * /api/v2/trader-styles — the Analytics "Trader styles" roster.
 *
 * Served from the ACCUMULATING style indexer (lib/analytics/v2-style-indexer): a
 * running per-owner style tally folded from the complete `OrderMinted` history, kept
 * fresh with cheap incremental deltas and cached in KV. That replaces the old
 * per-market fan-out, which was truncated to the newest ~50 markets / ~50 mints each
 * (an ~8h window) and left the tab reading empty on sparse testnet. The roster now
 * covers every trader all-time; the browser still makes ONE request.
 *
 * The indexer is stale-while-revalidate, so this stays fast: only a cold, never-seeded
 * instance waits for the first build. Degrades to `{ available:false }` on a hard failure.
 */
import { NextResponse } from 'next/server';
import { getStyleRoster } from '@/lib/analytics/v2-style-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(await getStyleRoster());
  } catch {
    return NextResponse.json({ available: false, asOf: Date.now(), traders: [], distribution: [], total: 0 });
  }
}
