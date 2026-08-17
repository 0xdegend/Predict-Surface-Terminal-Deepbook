/**
 * lib/walrus/receipt-format.ts — pure, dependency-free helpers for DISPLAYING a call receipt.
 *
 * Kept separate from lib/walrus/receipts.ts (which imports the Walrus write SDK + KV and is
 * server-only) so the read/share surfaces — the OG image, the per-call page, the client panel —
 * can format + fetch a receipt without pulling the writer bundle. Types come in via `import type`
 * (erased at compile), and the only runtime dep is the aggregator URL from config.
 */
import type { CallClaim, CallReceipt } from './receipts';
import { walrusConfig } from '@/config/walrus';

/** A compact one-line label for a call (feeds, share cards, OG). */
export function summarizeClaim(claim: CallClaim): string {
  // A read is a directional forecast scored at the call-time price, so we phrase it as a call
  // "from $X" and drop the ~50% probability (it's at-the-money, so the number says nothing).
  if (claim.role === 'read') {
    return `Called BTC ${claim.direction === 'up' ? 'up' : 'down'} from $${Math.round(claim.strike ?? 0).toLocaleString()}`;
  }
  const pct = `${Math.round(claim.probability * 100)}%`;
  if (claim.kind === 'range') {
    return `BTC stays $${Math.round(claim.lower ?? 0).toLocaleString()}–$${Math.round(claim.higher ?? 0).toLocaleString()} (${pct})`;
  }
  return `BTC ${claim.direction === 'up' ? 'above' : 'below'} $${Math.round(claim.strike ?? 0).toLocaleString()} (${pct})`;
}

/** The claim without the trailing probability, for headline use on a card. */
export function claimHeadline(claim: CallClaim): string {
  if (claim.role === 'read') {
    return `Kelly called BTC ${claim.direction === 'up' ? 'up' : 'down'} from $${Math.round(claim.strike ?? 0).toLocaleString()}`;
  }
  if (claim.kind === 'range') {
    return `BTC settles between $${Math.round(claim.lower ?? 0).toLocaleString()} and $${Math.round(claim.higher ?? 0).toLocaleString()}`;
  }
  return `BTC settles ${claim.direction === 'up' ? 'above' : 'below'} $${Math.round(claim.strike ?? 0).toLocaleString()}`;
}

/** The public, content-addressed receipt URL on the Walrus aggregator (anyone can open it). */
export function receiptBlobUrl(blobId: string): string {
  return `${walrusConfig.aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`;
}

/**
 * Fetch + parse a receipt from the public Walrus aggregator. Content-addressed, so the bytes
 * are authentic by construction (no wallet, no key). Client- and server-safe; null on failure.
 */
export async function fetchCallReceipt(blobId: string, signal?: AbortSignal): Promise<CallReceipt | null> {
  try {
    const res = await fetch(receiptBlobUrl(blobId), { signal });
    if (!res.ok) return null;
    return (await res.json()) as CallReceipt;
  } catch {
    return null;
  }
}
