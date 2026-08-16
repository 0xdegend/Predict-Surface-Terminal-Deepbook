/**
 * lib/copilot/receipts-client.ts — client side of Verifiable Call Receipts.
 *
 * When Kelly surfaces a concrete call (a bet/range recommendation), the host fires
 * `recordCall` here with a structural INTENT (which market, side/band). The route loads the
 * live pricer and recomputes the fair odds itself, then signs + stores the receipt on Walrus
 * (server-only writer key). Fire-and-forget + fail-soft: recording a call must never slow or
 * break a reply. Deduped per (market + side/band) and capped per session so re-renders and
 * repeat asks don't spam the store. `fetchTrackRecord` reads Kelly's public scoreboard.
 *
 * The intent carries NO odds/spot/forward — those are server-computed, so a caller can't forge
 * Kelly's numbers. Types come in via `import type` so the server-only receipts module is never bundled.
 */
import type { CallIntent, CallSource } from '@/lib/walrus/receipts';

const _recorded = new Set<string>();
let _count = 0;
const SESSION_CAP = 60;

function callKey(intent: CallIntent): string {
  return intent.kind === 'range'
    ? `r:${intent.marketId}:${Math.round(intent.lower ?? 0)}-${Math.round(intent.higher ?? 0)}`
    : `b:${intent.marketId}:${intent.direction}:${Math.round(intent.strike ?? 0)}`;
}

/** Build a binary call intent from a bet card. Odds are computed server-side. */
export function binaryIntent(o: {
  marketId: string;
  expiry: number;
  isUp: boolean;
  strikePrice: number;
  source?: CallSource;
}): CallIntent {
  return {
    kind: 'binary',
    marketId: o.marketId,
    expiry: o.expiry,
    source: o.source ?? 'rules',
    direction: o.isUp ? 'up' : 'down',
    strike: o.strikePrice,
  };
}

/** Build a range call intent from a range card. Odds are computed server-side. */
export function rangeIntent(o: {
  marketId: string;
  expiry: number;
  lower: number;
  higher: number;
  source?: CallSource;
}): CallIntent {
  return {
    kind: 'range',
    marketId: o.marketId,
    expiry: o.expiry,
    source: o.source ?? 'rules',
    lower: o.lower,
    higher: o.higher,
  };
}

/** Record a call Kelly just made. Deduped + capped + fail-soft; never throws. */
export async function recordCall(intent: CallIntent): Promise<void> {
  const key = callKey(intent);
  if (_recorded.has(key) || _count >= SESSION_CAP) return;
  _recorded.add(key);
  _count += 1;
  try {
    await fetch('/api/kelly/receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
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
