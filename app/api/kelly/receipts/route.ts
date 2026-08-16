/**
 * /api/kelly/receipts — Verifiable Call Receipts (Kelly × Walrus).
 *
 * POST → mint a signed, timestamped receipt for a call Kelly just made and store it on Walrus.
 *        Returns { id, blobId }. The blobId is the public, content-addressed handle: anyone can
 *        fetch it from the Walrus aggregator and verify Kelly's signature (see readCallReceipt).
 * GET  → Kelly's public track record: the recent calls, scored against live market settlement
 *        where available (won / lost / pending), plus a resolved-only win rate.
 *
 * SECURITY (hardening for a later slice, before this is a public trust surface): the mint trusts
 * the client-supplied probability/spot/forward. The TRACK RECORD is already objective (it scores
 * on strike/band vs real settlement, so a forged probability can't change won/lost), but to stop
 * a caller polluting the FEED with calls Kelly never surfaced, the server should recompute the
 * fair probability from the live pricer and/or require auth. Ships dark behind
 * NEXT_PUBLIC_KELLY_RECEIPTS, and returns 503 if WALRUS_WRITER_KEY isn't configured.
 */
import { NextResponse } from 'next/server';
import {
  mintCallReceipt,
  listCallReceipts,
  trackRecord,
  summarizeClaim,
  type CallClaim,
  type CallKind,
  type CallSource,
  type ReceiptIndexEntry,
} from '@/lib/walrus/receipts';
import { getV2MarketState } from '@/lib/api/v2/client';
import { toFloat } from '@/config/scale';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const posNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Validate + normalize a client-supplied claim into a CallClaim, or null if malformed. */
function parseClaim(body: Record<string, unknown>): CallClaim | null {
  const c = (body.claim ?? body) as Record<string, unknown>;
  const kind = c.kind === 'range' ? 'range' : c.kind === 'binary' ? 'binary' : null;
  if (!kind) return null;
  const marketId = String(c.marketId ?? '').trim();
  const expiry = Number(c.expiry);
  const probability = Number(c.probability);
  const spotAtCall = posNum(c.spotAtCall);
  const forward = posNum(c.forward);
  if (!marketId || !Number.isFinite(expiry) || expiry <= 0) return null;
  if (!(probability >= 0 && probability <= 1) || spotAtCall == null || forward == null) return null;

  const base = {
    kind: kind as CallKind,
    asset: 'BTC' as const,
    probability,
    spotAtCall,
    forward,
    expiry,
    marketId,
  };
  if (kind === 'binary') {
    const strike = posNum(c.strike);
    const direction = c.direction === 'down' ? 'down' : c.direction === 'up' ? 'up' : null;
    if (strike == null || !direction) return null;
    return { ...base, direction, strike };
  }
  const lower = posNum(c.lower);
  const higher = posNum(c.higher);
  if (lower == null || higher == null || higher <= lower) return null;
  return { ...base, lower, higher };
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.WALRUS_WRITER_KEY) {
    return NextResponse.json({ ok: false, error: 'unconfigured' }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  const claim = parseClaim(body);
  if (!claim) return NextResponse.json({ ok: false, error: 'invalid_claim' }, { status: 400 });
  const source: CallSource = body.source === 'ai' ? 'ai' : 'rules';
  try {
    const { id, blobId } = await mintCallReceipt({ claim, source });
    return NextResponse.json({ ok: true, id, blobId });
  } catch {
    // Fail soft — a Walrus hiccup should never surface to the trader (the call was made anyway).
    return NextResponse.json({ ok: false, error: 'store_failed' }, { status: 502 });
  }
}

/** How many settled-market reads to fan out per track-record request (bounds the cost). */
const MAX_SETTLEMENT_READS = 40;

/**
 * Best-effort settlement map (marketId → settlement price in USD) for the EXPIRED calls only.
 * Reads each distinct expired market's state (settlement lives on /markets/:id/state), deduped
 * and bounded. A market that isn't settled yet (or a flaky read) simply stays pending — honest.
 */
async function settlementMap(entries: ReceiptIndexEntry[], now: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const ids = [...new Set(entries.filter((e) => e.claim.expiry < now).map((e) => e.claim.marketId))].slice(
    0,
    MAX_SETTLEMENT_READS,
  );
  await Promise.all(
    ids.map(async (id) => {
      try {
        const st = await getV2MarketState(id);
        const sp = st?.settlement?.settlement_price;
        if (sp != null) {
          const usd = toFloat(sp);
          if (Number.isFinite(usd)) map.set(id, usd);
        }
      } catch {
        /* not settled / read flaky — leave pending */
      }
    }),
  );
  return map;
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit')) || 50), 1), 200);
  const now = Date.now();
  const entries = await listCallReceipts(limit);
  const settled = await settlementMap(entries, now);
  const tr = trackRecord(entries, (id) => settled.get(id) ?? null);
  return NextResponse.json({
    total: tr.total,
    resolved: tr.resolved,
    won: tr.won,
    lost: tr.lost,
    pending: tr.pending,
    winRate: tr.winRate,
    calls: tr.calls.map((c) => ({
      id: c.id,
      blobId: c.blobId,
      createdAt: c.createdAt,
      source: c.source,
      outcome: c.outcome,
      summary: summarizeClaim(c.claim),
      expiry: c.claim.expiry,
      marketId: c.claim.marketId,
    })),
  });
}
