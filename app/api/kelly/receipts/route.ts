/**
 * /api/kelly/receipts — Verifiable Call Receipts (Kelly × Walrus).
 *
 * POST → mint a signed, timestamped receipt for a call Kelly just made and store it on Walrus.
 *        Returns { id, blobId }. The blobId is the public, content-addressed handle: anyone can
 *        fetch it from the Walrus aggregator and verify Kelly's signature (see readCallReceipt).
 * GET  → Kelly's public track record: the recent calls, scored against live market settlement
 *        where available (won / lost / pending), plus a resolved-only win rate.
 *
 * TRUST: the client sends only a structural INTENT (which market, up/down/range, which strike or
 * band). The server loads the LIVE pricer for that market and recomputes the fair probability,
 * spot, and forward itself, so a caller can't forge Kelly's odds — and a call on a dead or fake
 * market is rejected outright (load_live_pricer aborts). The record is thus honest end to end.
 * Ships dark behind NEXT_PUBLIC_KELLY_RECEIPTS, and returns 503 if WALRUS_WRITER_KEY isn't set.
 */
import { NextResponse } from 'next/server';
import {
  mintCallReceipt,
  listCallReceipts,
  trackRecord,
  summarizeClaim,
  claimFromIntent,
  type CallIntent,
  type CallSource,
  type ReceiptIndexEntry,
} from '@/lib/walrus/receipts';
import { getV2MarketState, getPythLatest, pythSpot } from '@/lib/api/v2/client';
import { simulateLivePricer, v2GrpcClient, fairUp, fairDn, fairRange } from '@/lib/sui/v2/pricer';
import { predictV2Config } from '@/config/predict';
import { toFloat } from '@/config/scale';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const posNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Validate a client-supplied INTENT (structural only), or null if malformed. */
function parseIntent(body: Record<string, unknown>): CallIntent | null {
  const kind = body.kind === 'range' ? 'range' : body.kind === 'binary' ? 'binary' : null;
  if (!kind) return null;
  const marketId = String(body.marketId ?? '').trim();
  const expiry = Number(body.expiry);
  if (!marketId || !Number.isFinite(expiry) || expiry <= 0) return null;
  const source: CallSource = body.source === 'ai' ? 'ai' : 'rules';
  if (kind === 'binary') {
    const direction = body.direction === 'down' ? 'down' : body.direction === 'up' ? 'up' : null;
    if (!direction) return null;
    // A 'read' (directional forecast) carries no client strike — the server uses its own live
    // forward as the strike, so the call can't be gamed by sending a favorable level.
    if (body.role === 'read') return { kind, marketId, expiry, source, role: 'read', direction };
    const strike = posNum(body.strike);
    if (strike == null) return null;
    return { kind, marketId, expiry, source, direction, strike };
  }
  const lower = posNum(body.lower);
  const higher = posNum(body.higher);
  if (lower == null || higher == null || higher <= lower) return null;
  return { kind, marketId, expiry, source, lower, higher };
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
  const intent = parseIntent(body);
  if (!intent) return NextResponse.json({ ok: false, error: 'invalid_intent' }, { status: 400 });

  // Recompute the trustworthy fields from the LIVE pricer. This also validates the market:
  // load_live_pricer aborts on a nonexistent / expired / stale market, so a call can only be
  // recorded on a real, currently-tradeable one.
  let priced;
  try {
    const pricer = await simulateLivePricer(v2GrpcClient(), intent.marketId);
    // A read is priced at the live forward (its scoring strike); a pick at its own strike.
    const binaryStrike = intent.role === 'read' ? pricer.forward : intent.strike!;
    const probability =
      intent.kind === 'range'
        ? fairRange(pricer, intent.lower!, intent.higher!)
        : intent.direction === 'up'
          ? fairUp(pricer, binaryStrike)
          : fairDn(pricer, binaryStrike);
    if (!(probability >= 0 && probability <= 1)) throw new Error('probability out of range');
    const spot = pythSpot(await getPythLatest(predictV2Config.asset.pythFeedId).catch(() => null)) ?? pricer.forward;
    priced = { probability, spotAtCall: spot, forward: pricer.forward };
  } catch {
    return NextResponse.json({ ok: false, error: 'market_not_priceable' }, { status: 400 });
  }

  try {
    const { id, blobId } = await mintCallReceipt({ claim: claimFromIntent(intent, priced), source: intent.source });
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
  // Split the scoreboard by role: 'read' = Kelly's directional forecasts (hit rate vs 50%),
  // everything else = concrete bet picks. The overall block stays as-is for back-compat.
  const split = (calls: typeof tr.calls) => {
    const won = calls.filter((c) => c.outcome === 'won').length;
    const lost = calls.filter((c) => c.outcome === 'lost').length;
    const pending = calls.filter((c) => c.outcome === 'pending').length;
    return { total: calls.length, resolved: won + lost, won, lost, pending, winRate: won + lost > 0 ? won / (won + lost) : null };
  };
  const reads = tr.calls.filter((c) => c.claim.role === 'read');
  const picks = tr.calls.filter((c) => c.claim.role !== 'read');
  return NextResponse.json({
    total: tr.total,
    resolved: tr.resolved,
    won: tr.won,
    lost: tr.lost,
    pending: tr.pending,
    winRate: tr.winRate,
    forecast: split(reads),
    picks: split(picks),
    calls: tr.calls.map((c) => ({
      id: c.id,
      blobId: c.blobId,
      createdAt: c.createdAt,
      source: c.source,
      role: c.claim.role ?? 'pick',
      outcome: c.outcome,
      summary: summarizeClaim(c.claim),
      expiry: c.claim.expiry,
      marketId: c.claim.marketId,
    })),
  });
}
