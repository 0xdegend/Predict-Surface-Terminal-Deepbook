/**
 * lib/copilot/receipts-client.ts — client side of Verifiable Call Receipts.
 *
 * When Kelly surfaces a concrete call (a bet/range recommendation), the host fires
 * `recordCall` here, which POSTs to /api/kelly/receipts. The route signs + stores the receipt
 * on Walrus (server-only writer key). Fire-and-forget + fail-soft: recording a call must never
 * slow or break a reply. Deduped per (market + side/band) and capped per session so re-renders
 * and repeat asks don't spam the store. `fetchTrackRecord` reads Kelly's public scoreboard.
 *
 * Types come in via `import type` so the server-only lib/walrus/receipts module is never bundled.
 */
import type { CallClaim, CallSource } from '@/lib/walrus/receipts';

const _recorded = new Set<string>();
let _count = 0;
const SESSION_CAP = 60;

function callKey(claim: CallClaim): string {
  return claim.kind === 'range'
    ? `r:${claim.marketId}:${Math.round(claim.lower ?? 0)}-${Math.round(claim.higher ?? 0)}`
    : `b:${claim.marketId}:${claim.direction}:${Math.round(claim.strike ?? 0)}`;
}

/** Build a binary call claim from a bet card + live spot/forward. */
export function binaryClaim(o: {
  marketId: string;
  expiry: number;
  isUp: boolean;
  strikePrice: number;
  prob: number;
  spot: number;
  forward: number;
}): CallClaim {
  return {
    kind: 'binary',
    asset: 'BTC',
    direction: o.isUp ? 'up' : 'down',
    strike: o.strikePrice,
    probability: o.prob,
    spotAtCall: o.spot,
    forward: o.forward,
    expiry: o.expiry,
    marketId: o.marketId,
  };
}

/** Build a range call claim from a range card + live spot/forward. */
export function rangeClaim(o: {
  marketId: string;
  expiry: number;
  lower: number;
  higher: number;
  prob: number;
  spot: number;
  forward: number;
}): CallClaim {
  return {
    kind: 'range',
    asset: 'BTC',
    lower: o.lower,
    higher: o.higher,
    probability: o.prob,
    spotAtCall: o.spot,
    forward: o.forward,
    expiry: o.expiry,
    marketId: o.marketId,
  };
}

/** Record a call Kelly just made. Deduped + capped + fail-soft; never throws. */
export async function recordCall(claim: CallClaim, source: CallSource = 'rules'): Promise<void> {
  const key = callKey(claim);
  if (_recorded.has(key) || _count >= SESSION_CAP) return;
  _recorded.add(key);
  _count += 1;
  try {
    await fetch('/api/kelly/receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim, source }),
    });
  } catch {
    /* fail soft — the call was still made; the receipt just didn't store this time */
  }
}

export interface TrackRecordCall {
  id: string;
  blobId: string;
  createdAt: number;
  source: CallSource;
  outcome: 'won' | 'lost' | 'pending';
  summary: string;
  expiry: number;
  marketId: string;
}

export interface TrackRecordResponse {
  total: number;
  resolved: number;
  won: number;
  lost: number;
  pending: number;
  winRate: number | null;
  calls: TrackRecordCall[];
}

/** Read Kelly's public track record (scored calls + resolved-only win rate). */
export async function fetchTrackRecord(limit = 50): Promise<TrackRecordResponse | null> {
  try {
    const res = await fetch(`/api/kelly/receipts?limit=${limit}`, { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as TrackRecordResponse;
  } catch {
    return null;
  }
}
